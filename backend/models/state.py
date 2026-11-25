from dataclasses import dataclass


@dataclass
class StateMachineConfig:
    sample_fps: float = 2.0
    freeze_confirmation_ms: int = 10000
    recovery_samples: int = 2
    max_pts_gap_sec: float = 5.0
