# Future Roadmap — HLS Freeze Monitor

Planned enhancements for future iterations, designed to keep the core Rust + FFmpeg + FastAPI pipeline lightweight and low-CPU.

---

## 1. Green Screen Detection (`GREEN_SCREEN`)
- **Approach:** Inspect `U` and `V` chroma planes directly from decoded `YUV420P` / `NV12` frames in `rust_frame_reader/src/lib.rs` before converting to `GRAY8` (zero extra decode cost, 1/4th pixel count).
- **Heuristic:** In BT.601/BT.709 YUV, pure green has `U < 90` and `V < 80` (vs. normal ~128). Trigger `GREEN_SCREEN` alert if green-pixel ratio exceeds threshold (e.g., `>= 70%`) for `N` consecutive samples.
- **Estimated Overhead:** `< 0.05 ms` per sampled frame.

## 2. Video Glitches & Corruption (`GLITCH_DETECTED`)
- **Decoder Bitstream Errors:** Check `AVFrame.decode_error_flags` and packet/decode error counters in `NativeFrameExtractor` to catch corrupted H.264/HEVC packets and missing slices.
- **Visual Macroblocking / Artifact Spike:** Measure `8×8` / `16×16` block-boundary gradient vs. interior pixel gradient on `GRAY8`, plus extreme `U/V` chroma spikes (pink/green block artifacts).
- **Estimated Overhead:** `< 0.1 ms` per sampled frame.

## 3. Black Screen / Signal Loss (`BLACK_SCREEN`)
- **Approach:** Compute mean luma (`mean(Y) < 18`) and luma variance/stddev (`stddev < 5`) on the existing `GRAY8` buffer.
- **Estimated Overhead:** `0` extra memory; fuses into the existing pixel pass.

## 4. Multi-Channel Support
- Extend `MonitorManager` in `backend/server.py` to manage multiple concurrent `channel_id` workers, with per-channel filtering in `/api/logs`, `/api/metrics`, and the React dashboard.

## 5. Optional Semantic / AI Detection (ONNX / PyTorch)
- Only needed for content-level anomalies where pixels are still moving (e.g., spinning loading indicator, "Signal Lost / Please Stand By" slate, camera occlusion).
- Keep optional/off by default so core container RAM stays under `~85 MiB`.
