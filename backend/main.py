from detector import FreezeStateMachine, NativeMonitorRunner
from models import StateMachineConfig, StreamExtractConfig, ZoneMetricConfig

if __name__ == "__main__":
    url = "https://cloud.ottlive.co.in/vandebharat/vandebharat/index.m3u8"
    ext_cfg = StreamExtractConfig(hls_url=url, sample_fps=3.0)
    met_cfg = ZoneMetricConfig(
        proc_width=ext_cfg.proc_width,
        proc_height=ext_cfg.proc_height,
    )
    sm = FreezeStateMachine(StateMachineConfig(sample_fps=ext_cfg.sample_fps))

    NativeMonitorRunner(
        channel_id="channel_001",
        extract_cfg=ext_cfg,
        metric_cfg=met_cfg,
        state_machine=sm,
    ).run()
