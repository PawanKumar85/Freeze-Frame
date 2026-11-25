from dataclasses import dataclass


# --------------------------------------------------
# Configuration
# --------------------------------------------------

@dataclass
class StreamExtractConfig:
    hls_url: str

    input_width: int = 1920
    input_height: int = 1080

    roi_x: float = 0.0
    roi_y: float = 0.0
    roi_width: float = 1.0
    roi_height: float = 1.0

    proc_width: int = 240
    proc_height: int = 135

    sample_fps: float = 2.0
    eco_mode: bool = False

    queue_maxsize: int = 100
    pts_timeout: float = 2.0
    shutdown_timeout: float = 3.0


# --------------------------------------------------
# Frame Output Contract
# --------------------------------------------------

@dataclass
class ExtractedFrame:
    pts: float
    width: int
    height: int
    pixel_format: str
    data: bytes
