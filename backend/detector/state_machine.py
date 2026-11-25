import math
from typing import Optional

from models import StateMachineConfig


class FreezeStateMachine:
    def __init__(self, cfg: StateMachineConfig):
        self.cfg = cfg
        self.confirm_samples = max(1, math.ceil(cfg.freeze_confirmation_ms * cfg.sample_fps / 1000.0))
        self.prev_pts: Optional[float] = None
        self.frozen_streak = 0
        self.normal_streak = 0
        self.is_frozen = False

    def reset_window(self) -> None:
        self.frozen_streak = 0
        self.normal_streak = 0

    def step(self, pts: Optional[float], is_static_frame: Optional[bool]) -> list[str]:
        events: list[str] = []

        if self.prev_pts is not None and pts is not None:
            delta = pts - self.prev_pts
            if delta < 0 or delta > self.cfg.max_pts_gap_sec:
                self.reset_window()
                events.append("PTS_DISCONTINUITY_RESET")
                self.prev_pts = pts
                return events

        if pts is not None:
            self.prev_pts = pts

        if is_static_frame is None:
            return events

        if is_static_frame:
            self.frozen_streak += 1
            self.normal_streak = 0
            if not self.is_frozen and self.frozen_streak >= self.confirm_samples:
                self.is_frozen = True
                events.append("FREEZE_DETECTED")
        else:
            self.normal_streak += 1
            self.frozen_streak = 0
            if self.is_frozen and self.normal_streak >= self.cfg.recovery_samples:
                self.is_frozen = False
                events.append("FREEZE_RECOVERED")

        return events
