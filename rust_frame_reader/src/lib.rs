use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};

use ffmpeg_next as ffmpeg;
use ffmpeg_next::format::Pixel;
use ffmpeg_next::software::scaling::{Context as SwsContext, Flags};
use pyo3::buffer::PyBuffer;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};

static FFMPEG_INIT: Once = Once::new();

fn init_ffmpeg() {
    FFMPEG_INIT.call_once(|| {
        let _ = ffmpeg::init();
    });
}

fn has_8bit_luma_plane(fmt: Pixel) -> bool {
    matches!(
        fmt,
        Pixel::GRAY8
            | Pixel::YUV420P
            | Pixel::YUVJ420P
            | Pixel::YUV422P
            | Pixel::YUVJ422P
            | Pixel::YUV444P
            | Pixel::YUVJ444P
            | Pixel::NV12
            | Pixel::NV21
    )
}

struct ScalerState {
    src_w: u32,
    src_h: u32,
    src_fmt: Pixel,
    crop_x: usize,
    crop_y: usize,
    crop_h: u32,
    to_gray: Option<SwsContext>,
    crop_scale: SwsContext,
    gray_tmp: ffmpeg::frame::Video,
}

unsafe impl Send for ScalerState {}

unsafe extern "C" fn avio_interrupt_cb(opaque: *mut libc::c_void) -> libc::c_int {
    if opaque.is_null() {
        return 0;
    }
    let flag = &*(opaque as *const AtomicBool);
    if flag.load(Ordering::Relaxed) { 1 } else { 0 }
}

struct Pipeline {
    ictx: Option<ffmpeg::format::context::Input>,
    interrupt_ptr: *const AtomicBool,
    video_stream_index: usize,
    time_base: f64,
    decoder: ffmpeg::decoder::Video,
    scaler: Option<ScalerState>,
    eof_sent: bool,
    next_sample_pts: Option<f64>,
}

unsafe impl Send for Pipeline {}

impl Drop for Pipeline {
    fn drop(&mut self) {
        // Drop Input before freeing the interrupt_callback AtomicBool pointer.
        self.ictx.take();
        if !self.interrupt_ptr.is_null() {
            unsafe {
                drop(Arc::from_raw(self.interrupt_ptr));
            }
            self.interrupt_ptr = std::ptr::null();
        }
    }
}

fn open_video_pipeline(
    url: &str,
    stop_flag: &Arc<AtomicBool>,
    eco_mode: bool,
) -> Result<Pipeline, ffmpeg::Error> {
    let mut opts = ffmpeg::Dictionary::new();
    if url.starts_with("http://") || url.starts_with("https://") {
        opts.set("reconnect", "1");
        opts.set("reconnect_streamed", "1");
        opts.set("reconnect_delay_max", "2");
        opts.set("http_persistent", "1");
        opts.set("probesize", "500000");
        opts.set("analyzeduration", "1000000");
    }
    let mut ictx = ffmpeg::format::input_with_dictionary(url, opts)?;
    let interrupt_ptr = Arc::into_raw(Arc::clone(stop_flag));
    unsafe {
        (*ictx.as_mut_ptr()).interrupt_callback = ffmpeg::ffi::AVIOInterruptCB {
            callback: Some(avio_interrupt_cb),
            opaque: interrupt_ptr as *mut libc::c_void,
        };
    }
    let stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or(ffmpeg::Error::StreamNotFound)?;

    let video_stream_index = stream.index();
    let time_base = f64::from(stream.time_base());
    let mut ctx = ffmpeg::codec::context::Context::from_parameters(stream.parameters())?;
    ctx.set_threading(ffmpeg::codec::threading::Config {
        kind: ffmpeg::codec::threading::Type::Frame,
        count: 1,
    });
    // Skip H.264 deblocking loop filter & non-reference B-frames to cut decode CPU
    // safely across both closed-GOP and open-GOP broadcast streams.
    unsafe {
        let avctx = ctx.as_mut_ptr();
        (*avctx).skip_loop_filter = ffmpeg::ffi::AVDiscard::AVDISCARD_ALL;
        (*avctx).skip_frame = ffmpeg::ffi::AVDiscard::AVDISCARD_NONREF;
        let _ = eco_mode;
        for mut s in ictx.streams_mut() {
            if s.index() != video_stream_index {
                (*s.as_mut_ptr()).discard = ffmpeg::ffi::AVDiscard::AVDISCARD_ALL;
            }
        }
    }
    let decoder = ctx.decoder().video()?;

    Ok(Pipeline {
        ictx: Some(ictx),
        interrupt_ptr,
        video_stream_index,
        time_base,
        decoder,
        scaler: None,
        eof_sent: false,
        next_sample_pts: None,
    })
}

#[pyclass]
pub struct NativeFrameExtractor {
    hls_url: String,
    roi_x: f64,
    roi_y: f64,
    roi_width: f64,
    roi_height: f64,
    proc_width: u32,
    proc_height: u32,
    sample_fps: f64,
    eco_mode: bool,
    pipeline: Mutex<Option<Pipeline>>,
    stop_flag: Arc<AtomicBool>,
}

impl NativeFrameExtractor {
    fn build_scaler(
        roi_x: f64,
        roi_y: f64,
        roi_width: f64,
        roi_height: f64,
        proc_width: u32,
        proc_height: u32,
        frame: &ffmpeg::frame::Video,
    ) -> Result<ScalerState, ffmpeg::Error> {
        let in_w = frame.width();
        let in_h = frame.height();
        let src_fmt = frame.format();

        if in_w < 2 || in_h < 2 {
            return Err(ffmpeg::Error::InvalidData);
        }

        let mut crop_x = ((in_w as f64) * roi_x).round() as u32;
        let mut crop_y = ((in_h as f64) * roi_y).round() as u32;
        crop_x -= crop_x % 2;
        crop_y -= crop_y % 2;
        crop_x = crop_x.min(in_w.saturating_sub(2));
        crop_y = crop_y.min(in_h.saturating_sub(2));

        let mut crop_w = ((in_w as f64) * roi_width).round().max(2.0) as u32;
        let mut crop_h = ((in_h as f64) * roi_height).round().max(2.0) as u32;

        // Ensure even dimensions and bounds safety.
        crop_w -= crop_w % 2;
        crop_h -= crop_h % 2;
        crop_w = crop_w.min(in_w.saturating_sub(crop_x)).max(2);
        crop_h = crop_h.min(in_h.saturating_sub(crop_y)).max(2);

        let to_gray = if has_8bit_luma_plane(src_fmt) {
            None
        } else {
            Some(SwsContext::get(
                src_fmt,
                in_w,
                in_h,
                Pixel::GRAY8,
                in_w,
                in_h,
                Flags::FAST_BILINEAR,
            )?)
        };

        let crop_scale = SwsContext::get(
            Pixel::GRAY8,
            crop_w,
            crop_h,
            Pixel::GRAY8,
            proc_width,
            proc_height,
            Flags::FAST_BILINEAR,
        )?;

        Ok(ScalerState {
            src_w: in_w,
            src_h: in_h,
            src_fmt,
            crop_x: crop_x as usize,
            crop_y: crop_y as usize,
            crop_h,
            to_gray,
            crop_scale,
            gray_tmp: ffmpeg::frame::Video::empty(),
        })
    }

    fn crop_and_scale_gray_into(
        scaler: &mut ScalerState,
        decoded: &ffmpeg::frame::Video,
        proc_width: u32,
        proc_height: u32,
        out: &mut Vec<u8>,
    ) -> Result<(), ffmpeg::Error> {
        let luma_frame: &ffmpeg::frame::Video = if let Some(ref mut to_gray) = scaler.to_gray {
            to_gray.run(decoded, &mut scaler.gray_tmp)?;
            &scaler.gray_tmp
        } else {
            decoded
        };

        let src_stride = luma_frame.stride(0);
        let src_data = luma_frame.data(0);
        let offset = scaler.crop_y * src_stride + scaler.crop_x;

        let out_w = proc_width as usize;
        let out_h = proc_height as usize;
        out.resize(out_w * out_h, 0);

        unsafe {
            let src_ptr = src_data.as_ptr().add(offset);
            let src_slices = [src_ptr];
            let src_strides = [src_stride as libc::c_int];
            let mut dst_slices = [out.as_mut_ptr()];
            let dst_strides = [out_w as libc::c_int];

            ffmpeg::ffi::sws_scale(
                scaler.crop_scale.as_mut_ptr(),
                src_slices.as_ptr(),
                src_strides.as_ptr(),
                0,
                scaler.crop_h as libc::c_int,
                dst_slices.as_mut_ptr(),
                dst_strides.as_ptr(),
            );
        }

        Ok(())
    }

    fn pull_next_frame_into(&self, out: &mut Vec<u8>) -> Result<Option<f64>, String> {
        let roi_x = self.roi_x;
        let roi_y = self.roi_y;
        let roi_width = self.roi_width;
        let roi_height = self.roi_height;
        let proc_width = self.proc_width;
        let proc_height = self.proc_height;
        let sample_interval = 1.0 / self.sample_fps;

        let mut guard = self
            .pipeline
            .lock()
            .map_err(|_| "Pipeline lock poisoned".to_string())?;
        let pipeline = match guard.as_mut() {
            Some(p) => p,
            None => return Ok(None),
        };

        let mut decoded = ffmpeg::frame::Video::empty();

        loop {
            if self.stop_flag.load(Ordering::Relaxed) {
                return Ok(None);
            }

            // 1. Drain decoded frames; sample at target FPS and crop+scale only kept frames.
            if pipeline.decoder.receive_frame(&mut decoded).is_ok() {
                let pts = (decoded.pts().unwrap_or(0) as f64) * pipeline.time_base;

                let should_emit = match pipeline.next_sample_pts {
                    None => true,
                    Some(next_pts) => {
                        if pts + 0.05 < next_pts - sample_interval || pts > next_pts + 1.0 {
                            pipeline.next_sample_pts = None;
                            true
                        } else {
                            pts + 1e-6 >= next_pts
                        }
                    }
                };

                if !should_emit {
                    continue;
                }

                pipeline.next_sample_pts = Some(
                    pipeline
                        .next_sample_pts
                        .map_or(pts + sample_interval, |p| p + sample_interval),
                );

                let needs_rebuild = match pipeline.scaler.as_ref() {
                    Some(s) => {
                        s.src_w != decoded.width()
                            || s.src_h != decoded.height()
                            || s.src_fmt != decoded.format()
                    }
                    None => true,
                };

                if needs_rebuild {
                    pipeline.scaler = Some(
                        Self::build_scaler(
                            roi_x,
                            roi_y,
                            roi_width,
                            roi_height,
                            proc_width,
                            proc_height,
                            &decoded,
                        )
                        .map_err(|e| format!("build_scaler: {e}"))?,
                    );
                }

                let scaler = pipeline.scaler.as_mut().unwrap();
                Self::crop_and_scale_gray_into(scaler, &decoded, proc_width, proc_height, out)
                    .map_err(|e| format!("crop_and_scale_gray: {e}"))?;
                return Ok(Some(pts));
            }

            if pipeline.eof_sent {
                return Ok(None);
            }

            // 2. Read next packet from demuxer and feed decoder.
            let mut got_video_packet = false;
            if let Some(ictx) = pipeline.ictx.as_mut() {
                for (stream, packet) in ictx.packets() {
                    if self.stop_flag.load(Ordering::Relaxed) {
                        return Ok(None);
                    }
                    if stream.index() == pipeline.video_stream_index {
                        match pipeline.decoder.send_packet(&packet) {
                            Ok(()) => {}
                            Err(ffmpeg::Error::Eof) => break,
                            Err(e) => return Err(format!("send_packet: {e}")),
                        }
                        got_video_packet = true;
                        break;
                    }
                }
            }

            if !got_video_packet {
                match pipeline.decoder.send_eof() {
                    Ok(()) | Err(ffmpeg::Error::Eof) => {}
                    Err(e) => return Err(format!("send_eof: {e}")),
                }
                pipeline.eof_sent = true;
            }
        }
    }

    fn pull_next_frame(&self) -> Result<Option<(f64, Vec<u8>)>, String> {
        let mut out = Vec::with_capacity((self.proc_width * self.proc_height) as usize);
        match self.pull_next_frame_into(&mut out)? {
            Some(pts) => Ok(Some((pts, out))),
            None => Ok(None),
        }
    }
}

#[pymethods]
impl NativeFrameExtractor {
    #[new]
    #[pyo3(signature = (
        hls_url,
        roi_x = 0.0,
        roi_y = 0.0,
        roi_width = 1.0,
        roi_height = 1.0,
        proc_width = 320,
        proc_height = 180,
        sample_fps = 2.0,
        eco_mode = false,
    ))]
    pub fn new(
        hls_url: String,
        roi_x: f64,
        roi_y: f64,
        roi_width: f64,
        roi_height: f64,
        proc_width: u32,
        proc_height: u32,
        sample_fps: f64,
        eco_mode: bool,
    ) -> PyResult<Self> {
        if hls_url.is_empty() {
            return Err(PyValueError::new_err("HLS URL is required"));
        }
        if proc_width < 2 || proc_height < 2 {
            return Err(PyValueError::new_err("Invalid processing resolution"));
        }
        if sample_fps <= 0.0 {
            return Err(PyValueError::new_err("Invalid sample FPS"));
        }
        if !(0.0 < roi_width && roi_width <= 1.0)
            || !(0.0 < roi_height && roi_height <= 1.0)
            || !(0.0 <= roi_x && roi_x < 1.0)
            || !(0.0 <= roi_y && roi_y < 1.0)
            || roi_x + roi_width > 1.0
            || roi_y + roi_height > 1.0
        {
            return Err(PyValueError::new_err("Invalid ROI configuration"));
        }

        init_ffmpeg();

        Ok(Self {
            hls_url,
            roi_x,
            roi_y,
            roi_width,
            roi_height,
            proc_width,
            proc_height,
            sample_fps,
            eco_mode,
            pipeline: Mutex::new(None),
            stop_flag: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn start(&self, py: Python<'_>) -> PyResult<()> {
        {
            let guard = self
                .pipeline
                .lock()
                .map_err(|_| PyRuntimeError::new_err("Pipeline lock poisoned"))?;
            if guard.is_some() || self.stop_flag.load(Ordering::Relaxed) {
                return Err(PyRuntimeError::new_err(
                    "NativeFrameExtractor is already running or closed",
                ));
            }
        }

        let url = self.hls_url.clone();
        let stop_flag = Arc::clone(&self.stop_flag);
        let eco_mode = self.eco_mode;
        let pipeline = py
            .allow_threads(move || open_video_pipeline(&url, &stop_flag, eco_mode))
            .map_err(|e| PyRuntimeError::new_err(format!("Failed to open stream: {e}")))?;

        let mut guard = self
            .pipeline
            .lock()
            .map_err(|_| PyRuntimeError::new_err("Pipeline lock poisoned"))?;
        *guard = Some(pipeline);
        Ok(())
    }

    pub fn next_frame<'py>(&self, py: Python<'py>) -> PyResult<Option<(f64, Bound<'py, PyBytes>)>> {
        if self.stop_flag.load(Ordering::Relaxed) {
            return Ok(None);
        }

        let result = py
            .allow_threads(|| self.pull_next_frame())
            .map_err(|e| PyRuntimeError::new_err(format!("Decode error: {e}")))?;

        Ok(result.map(|(pts, bytes)| (pts, PyBytes::new_bound(py, &bytes))))
    }

    pub fn close(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    fn __enter__<'py>(slf: PyRef<'py, Self>, py: Python<'py>) -> PyResult<PyRef<'py, Self>> {
        let is_none = slf
            .pipeline
            .lock()
            .map_err(|_| PyRuntimeError::new_err("Pipeline lock poisoned"))?
            .is_none();
        if is_none && !slf.stop_flag.load(Ordering::Relaxed) {
            slf.start(py)?;
        }
        Ok(slf)
    }

    #[pyo3(signature = (_exc_type=None, _exc_val=None, _exc_tb=None))]
    fn __exit__(
        &self,
        _exc_type: Option<&Bound<'_, PyAny>>,
        _exc_val: Option<&Bound<'_, PyAny>>,
        _exc_tb: Option<&Bound<'_, PyAny>>,
    ) {
        self.close();
    }
}

fn extract_u8_slice<'a>(
    obj: &'a Bound<'_, PyAny>,
    expected_len: usize,
) -> PyResult<Vec<u8>> {
    if let Ok(bytes) = obj.extract::<&[u8]>() {
        if bytes.len() != expected_len {
            return Err(PyValueError::new_err(format!(
                "Expected {expected_len} bytes, got {}",
                bytes.len()
            )));
        }
        return Ok(bytes.to_vec());
    }

    let buf = PyBuffer::<u8>::get_bound(obj)?;
    if buf.item_count() != expected_len {
        return Err(PyValueError::new_err(format!(
            "Expected {expected_len} bytes, got {}",
            buf.item_count()
        )));
    }
    let slice = buf
        .as_slice(obj.py())
        .ok_or_else(|| PyValueError::new_err("Buffer must be C-contiguous uint8"))?;
    // Safety: PyBuffer<u8> guarantees ReadOnlyCell<u8> layout matches u8.
    let raw: Vec<u8> = slice.iter().map(|c| c.get()).collect();
    Ok(raw)
}

fn compute_zone_mae_and_ssim(
    prev: &[u8],
    curr: &[u8],
    frame_w: usize,
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
    mae_threshold: f64,
    motion_pixel_delta: u32,
    max_motion_ratio: f64,
    pref: &mut Vec<(u64, u64, u64, u64, u64)>,
) -> (f64, f64) {
    let zw = x1 - x0;
    let zh = y1 - y0;
    let count = (zw * zh) as f64;

    let mut abs_diff_sum: u64 = 0;
    let mut moved_pixels: u64 = 0;
    for y in y0..y1 {
        let row_off = y * frame_w;
        for x in x0..x1 {
            let p = prev[row_off + x] as i32;
            let c = curr[row_off + x] as i32;
            let diff = (c - p).unsigned_abs();
            abs_diff_sum += diff as u64;
            if diff > motion_pixel_delta {
                moved_pixels += 1;
            }
        }
    }
    let mae = (abs_diff_sum as f64) / count;
    let motion_ratio = (moved_pixels as f64) / count;

    // Early-exit: if MAE or moving-pixel ratio exceeds threshold, zone is moving.
    if mae > mae_threshold || motion_ratio > max_motion_ratio {
        return (mae, 0.0);
    }

    let min_dim = zw.min(zh);
    let win = (if min_dim % 2 == 1 { min_dim } else { min_dim.saturating_sub(1) }).min(7);
    if win < 3 {
        return (mae, 1.0);
    }

    // 2D prefix sums of (x, y, x^2, y^2, x*y) for O(1) window SSIM (reuses scratch Vec).
    let stride = zw + 1;
    let needed = (zh + 1) * stride;
    pref.resize(needed, (0, 0, 0, 0, 0));
    pref[..needed].fill((0, 0, 0, 0, 0));

    for ly in 0..zh {
        let frame_row = (y0 + ly) * frame_w;
        let cur_row = (ly + 1) * stride;
        let prev_row = ly * stride;
        let mut row_acc = (0u64, 0u64, 0u64, 0u64, 0u64);

        for lx in 0..zw {
            let p = prev[frame_row + x0 + lx] as u64;
            let c = curr[frame_row + x0 + lx] as u64;
            row_acc.0 += p;
            row_acc.1 += c;
            row_acc.2 += p * p;
            row_acc.3 += c * c;
            row_acc.4 += p * c;

            let up = pref[prev_row + lx + 1];
            pref[cur_row + lx + 1] = (
                up.0 + row_acc.0,
                up.1 + row_acc.1,
                up.2 + row_acc.2,
                up.3 + row_acc.3,
                up.4 + row_acc.4,
            );
        }
    }

    let np = (win * win) as f64;
    let cov_norm = np / (np - 1.0);
    let c1 = (0.01_f64 * 255.0).powi(2);
    let c2 = (0.03_f64 * 255.0).powi(2);

    let wy_max = zh - win + 1;
    let wx_max = zw - win + 1;
    let mut ssim_sum = 0.0_f64;

    for wy in 0..wy_max {
        let r0 = wy * stride;
        let r1 = (wy + win) * stride;
        for wx in 0..wx_max {
            let a = pref[r1 + wx + win];
            let b = pref[r0 + wx + win];
            let c = pref[r1 + wx];
            let d = pref[r0 + wx];

            let sx = (a.0 + d.0 - b.0 - c.0) as f64;
            let sy = (a.1 + d.1 - b.1 - c.1) as f64;
            let sxx = (a.2 + d.2 - b.2 - c.2) as f64;
            let syy = (a.3 + d.3 - b.3 - c.3) as f64;
            let sxy = (a.4 + d.4 - b.4 - c.4) as f64;

            let ux = sx / np;
            let uy = sy / np;
            let vx = (cov_norm * (sxx / np - ux * ux)).max(0.0);
            let vy = (cov_norm * (syy / np - uy * uy)).max(0.0);
            let vxy = cov_norm * (sxy / np - ux * uy);

            let num = (2.0 * ux * uy + c1) * (2.0 * vxy + c2);
            let den = (ux * ux + uy * uy + c1) * (vx + vy + c2);
            ssim_sum += num / den;
        }
    }

    let mean_ssim = ssim_sum / ((wy_max * wx_max) as f64);
    (mae, mean_ssim)
}

#[pyfunction]
#[pyo3(signature = (
    prev_frame,
    curr_frame,
    width,
    height,
    grid_rows = 3,
    grid_cols = 3,
    ssim_threshold = 0.995,
    mae_threshold = 2.0,
    freeze_ratio = 0.80,
    motion_pixel_delta = 6,
    max_motion_ratio = 0.015,
))]
pub fn evaluate_zones<'py>(
    py: Python<'py>,
    prev_frame: &Bound<'py, PyAny>,
    curr_frame: &Bound<'py, PyAny>,
    width: usize,
    height: usize,
    grid_rows: usize,
    grid_cols: usize,
    ssim_threshold: f64,
    mae_threshold: f64,
    freeze_ratio: f64,
    motion_pixel_delta: u32,
    max_motion_ratio: f64,
) -> PyResult<Bound<'py, PyDict>> {
    if width < 2 || height < 2 {
        return Err(PyValueError::new_err("Frame width and height must be >= 2"));
    }
    if grid_rows == 0 || grid_cols == 0 || width < grid_cols || height < grid_rows {
        return Err(PyValueError::new_err("Invalid grid dimensions"));
    }
    let expected = width * height;
    let prev = extract_u8_slice(prev_frame, expected)?;
    let curr = extract_u8_slice(curr_frame, expected)?;

    let (static_zones, total_zones, ratio, is_static, zone_states) = py.allow_threads(move || {
        let mut pref = Vec::new();
        evaluate_zones_in_place(
            &prev,
            &curr,
            width,
            height,
            grid_rows,
            grid_cols,
            ssim_threshold,
            mae_threshold,
            freeze_ratio,
            motion_pixel_delta,
            max_motion_ratio,
            &mut pref,
        )
    });

    let out = PyDict::new_bound(py);
    out.set_item("static_zones", static_zones)?;
    out.set_item("total_zones", total_zones)?;
    out.set_item("freeze_ratio", ratio)?;
    out.set_item("is_static_frame", is_static)?;
    out.set_item("zone_states", zone_states)?;
    Ok(out)
}

fn evaluate_zones_in_place(
    prev: &[u8],
    curr: &[u8],
    width: usize,
    height: usize,
    grid_rows: usize,
    grid_cols: usize,
    ssim_threshold: f64,
    mae_threshold: f64,
    freeze_ratio: f64,
    motion_pixel_delta: u32,
    max_motion_ratio: f64,
    pref: &mut Vec<(u64, u64, u64, u64, u64)>,
) -> (usize, usize, f64, bool, Vec<bool>) {
    let mut static_zones: usize = 0;
    let total_zones = grid_rows * grid_cols;
    let mut zone_states = Vec::with_capacity(total_zones);

    for r in 0..grid_rows {
        let y0 = (r * height) / grid_rows;
        let y1 = ((r + 1) * height) / grid_rows;
        for c in 0..grid_cols {
            let x0 = (c * width) / grid_cols;
            let x1 = ((c + 1) * width) / grid_cols;

            let (mae, score) = compute_zone_mae_and_ssim(
                prev,
                curr,
                width,
                x0,
                x1,
                y0,
                y1,
                mae_threshold,
                motion_pixel_delta,
                max_motion_ratio,
                pref,
            );

            let is_zone_static = score >= ssim_threshold && mae <= mae_threshold;
            if is_zone_static {
                static_zones += 1;
            }
            zone_states.push(is_zone_static);
        }
    }

    let ratio = if total_zones > 0 {
        (static_zones as f64) / (total_zones as f64)
    } else {
        0.0
    };
    (static_zones, total_zones, ratio, ratio >= freeze_ratio, zone_states)
}

struct MonitorState {
    prev_gray: Vec<u8>,
    curr_gray: Vec<u8>,
    has_prev: bool,
    pref_scratch: Vec<(u64, u64, u64, u64, u64)>,
}

#[pyclass]
pub struct NativeFreezeMonitor {
    extractor: NativeFrameExtractor,
    grid_rows: usize,
    grid_cols: usize,
    ssim_threshold: f64,
    mae_threshold: f64,
    freeze_ratio: f64,
    motion_pixel_delta: u32,
    max_motion_ratio: f64,
    state: Mutex<MonitorState>,
}

#[pymethods]
impl NativeFreezeMonitor {
    #[new]
    #[pyo3(signature = (
        hls_url,
        roi_x = 0.0,
        roi_y = 0.0,
        roi_width = 1.0,
        roi_height = 1.0,
        proc_width = 320,
        proc_height = 180,
        sample_fps = 2.0,
        grid_rows = 3,
        grid_cols = 3,
        ssim_threshold = 0.995,
        mae_threshold = 2.0,
        freeze_ratio = 0.80,
        motion_pixel_delta = 6,
        max_motion_ratio = 0.015,
        eco_mode = false,
    ))]
    pub fn new(
        hls_url: String,
        roi_x: f64,
        roi_y: f64,
        roi_width: f64,
        roi_height: f64,
        proc_width: u32,
        proc_height: u32,
        sample_fps: f64,
        grid_rows: usize,
        grid_cols: usize,
        ssim_threshold: f64,
        mae_threshold: f64,
        freeze_ratio: f64,
        motion_pixel_delta: u32,
        max_motion_ratio: f64,
        eco_mode: bool,
    ) -> PyResult<Self> {
        if grid_rows == 0
            || grid_cols == 0
            || (proc_width as usize) < grid_cols
            || (proc_height as usize) < grid_rows
        {
            return Err(PyValueError::new_err("Invalid grid dimensions"));
        }
        let extractor = NativeFrameExtractor::new(
            hls_url,
            roi_x,
            roi_y,
            roi_width,
            roi_height,
            proc_width,
            proc_height,
            sample_fps,
            eco_mode,
        )?;
        let buf_len = (proc_width * proc_height) as usize;
        Ok(Self {
            extractor,
            grid_rows,
            grid_cols,
            ssim_threshold,
            mae_threshold,
            freeze_ratio,
            motion_pixel_delta,
            max_motion_ratio,
            state: Mutex::new(MonitorState {
                prev_gray: vec![0u8; buf_len],
                curr_gray: vec![0u8; buf_len],
                has_prev: false,
                pref_scratch: Vec::new(),
            }),
        })
    }

    pub fn start(&self, py: Python<'_>) -> PyResult<()> {
        if let Ok(mut st) = self.state.lock() {
            st.has_prev = false;
        }
        self.extractor.start(py)
    }

    pub fn reset_prev(&self) {
        if let Ok(mut st) = self.state.lock() {
            st.has_prev = false;
        }
    }

    pub fn next_step(
        &self,
        py: Python<'_>,
    ) -> PyResult<Option<(f64, Option<(usize, usize, f64, bool, Vec<bool>)>)>> {
        if self.extractor.stop_flag.load(Ordering::Relaxed) {
            return Ok(None);
        }

        let res = py
            .allow_threads(|| -> Result<Option<(f64, Option<(usize, usize, f64, bool, Vec<bool>)>)>, String> {
                let mut st = self
                    .state
                    .lock()
                    .map_err(|_| "Monitor state lock poisoned".to_string())?;
                let MonitorState {
                    prev_gray,
                    curr_gray,
                    has_prev,
                    pref_scratch,
                } = &mut *st;

                let pts = match self.extractor.pull_next_frame_into(curr_gray)? {
                    Some(p) => p,
                    None => return Ok(None),
                };

                if !*has_prev {
                    std::mem::swap(prev_gray, curr_gray);
                    *has_prev = true;
                    return Ok(Some((pts, None)));
                }

                let metrics = evaluate_zones_in_place(
                    prev_gray,
                    curr_gray,
                    self.extractor.proc_width as usize,
                    self.extractor.proc_height as usize,
                    self.grid_rows,
                    self.grid_cols,
                    self.ssim_threshold,
                    self.mae_threshold,
                    self.freeze_ratio,
                    self.motion_pixel_delta,
                    self.max_motion_ratio,
                    pref_scratch,
                );

                std::mem::swap(prev_gray, curr_gray);
                Ok(Some((pts, Some(metrics))))
            })
            .map_err(|e| PyRuntimeError::new_err(format!("Decode error: {e}")))?;

        Ok(res)
    }

    pub fn close(&self) {
        self.extractor.close();
    }

    fn __enter__<'py>(slf: PyRef<'py, Self>, py: Python<'py>) -> PyResult<PyRef<'py, Self>> {
        let is_none = slf
            .extractor
            .pipeline
            .lock()
            .map_err(|_| PyRuntimeError::new_err("Pipeline lock poisoned"))?
            .is_none();
        if is_none && !slf.extractor.stop_flag.load(Ordering::Relaxed) {
            slf.start(py)?;
        }
        Ok(slf)
    }

    #[pyo3(signature = (_exc_type=None, _exc_val=None, _exc_tb=None))]
    fn __exit__(
        &self,
        _exc_type: Option<&Bound<'_, PyAny>>,
        _exc_val: Option<&Bound<'_, PyAny>>,
        _exc_tb: Option<&Bound<'_, PyAny>>,
    ) {
        self.close();
    }
}

#[pymodule]
fn rust_frame_reader(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<NativeFrameExtractor>()?;
    m.add_class::<NativeFreezeMonitor>()?;
    m.add_function(wrap_pyfunction!(evaluate_zones, m)?)?;
    Ok(())
}
