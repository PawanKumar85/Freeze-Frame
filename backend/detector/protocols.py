from typing import Any, Iterator, Optional, Protocol

from models import ExtractedFrame, ZoneMetricConfig


class FrameStreamReader(Protocol):
    """Source of extracted frames with context-managed lifecycle."""

    def frames(self) -> Iterator[ExtractedFrame]:
        ...

    def __enter__(self) -> "FrameStreamReader":
        ...

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        ...


class FrameDecoder(Protocol):
    """Converts raw frame bytes into the representation expected by FrameEvaluator."""

    def __call__(self, buf: bytes, width: int, height: int) -> Any:
        ...


class FrameEvaluator(Protocol):
    """Computes static/freeze metrics between two consecutive frames."""

    def __call__(
        self,
        prev_frame: Any,
        curr_frame: Any,
        cfg: ZoneMetricConfig,
    ) -> dict:
        ...


class StateTracker(Protocol):
    """Tracks freeze/recovery/discontinuity state transitions over time."""

    def step(
        self,
        pts: Optional[float],
        is_static_frame: Optional[bool],
    ) -> list[str]:
        ...


class EventSink(Protocol):
    """Consumes emitted freeze/recovery event payloads."""

    def __call__(self, payload: dict) -> None:
        ...


class FrameSink(Protocol):
    """Consumes per-frame evaluation telemetry."""

    def __call__(self, payload: dict) -> None:
        ...


class AlertBroadcaster(Protocol):
    """Publishes real-time status, frame telemetry, and alert events to subscribers."""

    def subscribe(self) -> Any:
        ...

    def unsubscribe(self, subscriber: Any) -> None:
        ...

    def publish(self, event_name: str, payload: dict) -> None:
        ...
