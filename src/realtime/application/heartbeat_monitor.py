import asyncio
import time
from collections.abc import Callable

from fastapi import WebSocket
from loguru import logger

SWEEP_INTERVAL_SECONDS = 10
LIVENESS_TIMEOUT_SECONDS = 30


class HeartbeatMonitor:
    """Liveness tracking for collab sockets (EST-9).

    Tracks ``websocket → (flow_id, member_id, last_seen)`` and force-closes
    sockets that have been silent for ``LIVENESS_TIMEOUT_SECONDS``.  Clients
    heartbeat every 10s, but ANY inbound frame refreshes ``last_seen`` — the
    heartbeat is only the guaranteed minimum.

    The sweep action is a server-side ``websocket.close()``: the endpoint's
    pending receive then raises and its ``finally`` block becomes the single
    cleanup path (presence leave + lock release) for both protocol-detected
    disconnects and silent zombies.

    ``clock`` is injectable (default ``time.monotonic``) so tests can fake
    time and drive ``sweep_once`` directly.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        # websocket → {"flow_id": int, "member_id": str, "last_seen": float}
        self._connections: dict[WebSocket, dict] = {}

    def track(self, websocket: WebSocket, flow_id: int, member_id: str) -> None:
        """Start liveness tracking for a joined collab connection."""
        self._connections[websocket] = {
            "flow_id": flow_id,
            "member_id": member_id,
            "last_seen": self._clock(),
        }

    def touch(self, websocket: WebSocket) -> None:
        """Refresh ``last_seen`` — called for every inbound frame."""
        entry = self._connections.get(websocket)
        if entry is not None:
            entry["last_seen"] = self._clock()

    def forget(self, websocket: WebSocket) -> None:
        """Stop tracking a connection.  Safe to call when not tracked."""
        self._connections.pop(websocket, None)

    def lookup(self, websocket: WebSocket) -> tuple[int, str] | None:
        """Return ``(flow_id, member_id)`` for a tracked socket, or None."""
        entry = self._connections.get(websocket)
        if entry is None:
            return None
        return entry["flow_id"], entry["member_id"]

    async def sweep_once(self) -> list[WebSocket]:
        """Force-close every connection silent for the liveness timeout.

        Expired connections are forgotten immediately so a zombie is closed
        at most once; the endpoint's ``finally`` block (woken by the close)
        owns the actual presence/lock cleanup.  Returns the expired sockets.
        """
        now = self._clock()
        expired = [
            websocket
            for websocket, entry in self._connections.items()
            if now - entry["last_seen"] >= LIVENESS_TIMEOUT_SECONDS
        ]
        for websocket in expired:
            entry = self._connections.pop(websocket)
            logger.info(
                "heartbeat sweep: closing silent socket flow={} member={} "
                "silent_for={:.0f}s",
                entry["flow_id"],
                entry["member_id"],
                now - entry["last_seen"],
            )
            try:
                await websocket.close(code=1001, reason="heartbeat timeout")
            except Exception:
                # The socket may already be dead at the transport level; the
                # endpoint's finally block / registry on_drop seam still
                # perform the cleanup, so a failed close is not an error.
                logger.debug(
                    "heartbeat sweep: close failed (socket already dead) "
                    "flow={} member={}",
                    entry["flow_id"],
                    entry["member_id"],
                )
        return expired

    async def run(self) -> None:
        """Sweep loop — started once at application startup."""
        while True:
            await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
            await self.sweep_once()
