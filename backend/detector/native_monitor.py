from typing import Optional

from detector.protocols import EventSink, FrameSink, StateTracker
from models import StreamExtractConfig, ZoneMetricConfig


class NativeMonitorRunner:
    """Zero-copy in-process Rust extraction + evaluation runner."""

    def __init__(
        self,
        channel_id: str,
        extract_cfg: StreamExtractConfig,
        metric_cfg: ZoneMetricConfig,
        state_machine: StateTracker,
        on_event: EventSink = print,
        on_frame: Optional[FrameSink] = None,
    ) -> None:
        from rust_frame_reader import NativeFreezeMonitor

        self.channel_id = channel_id
        self.state_machine = state_machine
        self.on_event = on_event
        self.on_frame = on_frame
        self._monitor = NativeFreezeMonitor(
            hls_url=extract_cfg.hls_url,
            roi_x=extract_cfg.roi_x,
            roi_y=extract_cfg.roi_y,
            roi_width=extract_cfg.roi_width,
            roi_height=extract_cfg.roi_height,
            proc_width=extract_cfg.proc_width,
            proc_height=extract_cfg.proc_height,
            sample_fps=extract_cfg.sample_fps,
            grid_rows=metric_cfg.grid_rows,
            grid_cols=metric_cfg.grid_cols,
            ssim_threshold=metric_cfg.ssim_threshold,
            mae_threshold=metric_cfg.mae_threshold,
            freeze_ratio=metric_cfg.freeze_ratio,
            motion_pixel_delta=metric_cfg.motion_pixel_delta,
            max_motion_ratio=metric_cfg.max_motion_ratio,
            eco_mode=extract_cfg.eco_mode,
        )

    def run(self) -> None:
        with self._monitor:
            while True:
                step_item = self._monitor.next_step()
                if step_item is None:
                    break

                pts, metrics = step_item
                if metrics is None:
                    self.state_machine.step(pts, None)
                    continue

                static_zones, total_zones, freeze_ratio, is_static, zone_states = metrics
                events = self.state_machine.step(pts, is_static)

                discontinuity = False
                for ev in events:
                    if ev == "PTS_DISCONTINUITY_RESET":
                        self._monitor.reset_prev()
                        discontinuity = True
                        break
                    self.on_event({
                        "channel_id": self.channel_id,
                        "event": ev,
                        "pts_sec": pts,
                        "static_zones": f"{static_zones}/{total_zones}",
                        "freeze_ratio": round(freeze_ratio, 3),
                        "zone_states": zone_states,
                    })

                if self.on_frame is not None and not discontinuity:
                    self.on_frame({
                        "channel_id": self.channel_id,
                        "pts_sec": round(pts, 3),
                        "static_zones": f"{static_zones}/{total_zones}",
                        "freeze_ratio": round(freeze_ratio, 3),
                        "is_static_frame": is_static,
                        "is_frozen": getattr(self.state_machine, "is_frozen", False),
                        "zone_states": zone_states,
                    })

    def close(self) -> None:
        self._monitor.close()
