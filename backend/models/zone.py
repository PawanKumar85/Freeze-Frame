from dataclasses import dataclass


@dataclass
class ZoneMetricConfig:
    proc_width: int = 240
    proc_height: int = 135
    grid_rows: int = 3
    grid_cols: int = 3
    ssim_threshold: float = 0.995
    mae_threshold: float = 1.0
    freeze_ratio: float = 0.88
    motion_pixel_delta: int = 6
    max_motion_ratio: float = 0.015
