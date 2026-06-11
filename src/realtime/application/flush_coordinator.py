from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from application.collab_socket_registry import CollabSocketRegistry
    from application.presence_service import PresenceService
    from infrastructure.persistence.live_document_repository import (
        LiveDocumentRepository,
    )

FLUSH_INTERVAL_SECONDS = 300  # ~5 minutes


class FlushCoordinator:
    """Per-flow periodic flush-trigger coordinator (EST-7).

    Responsibilities
    ----------------
    * Start a per-flow asyncio timer task when the first client joins
      (``on_room_active``).
    * Cancel that task and GC the live document from Redis when the last
      client leaves (``on_room_empty``).
    * On each ~5-minute tick, resolve the *designated client* (oldest-joined
      member still connected) via ``PresenceService`` and send it a
      ``flush_requested`` frame via the registry's ``send_to``.  Only ONE
      socket receives the frame — no broadcast.

    The GC on ``on_room_empty`` deletes all four ``collab:flow:{id}:*`` Redis
    keys.  It is gated strictly on the room being truly empty (``count == 0``
    after the leaving member's SREM, enforced by ``PresenceService.leave``
    before it calls this hook).

    The periodic tick does NOT clear Redis — editors are still connected.

    ``interval`` and ``clock`` are injectable so unit tests can drive time
    without sleeping.  Mirror of ``HeartbeatMonitor.__init__`` pattern.
    """

    def __init__(
        self,
        presence_service: "PresenceService",
        registry: "CollabSocketRegistry",
        live_document_repository: "LiveDocumentRepository",
        interval: float = FLUSH_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._presence = presence_service
        self._registry = registry
        self._live_doc_repo = live_document_repository
        self._interval = interval
        self._clock = clock
        # flow_id → running asyncio.Task
        self._tasks: dict[int, asyncio.Task] = {}

    # ------------------------------------------------------------------
    # Room lifecycle hooks (called by PresenceService)
    # ------------------------------------------------------------------

    def on_room_active(self, flow_id: int) -> None:
        """Called when the first member joins an empty flow (0 → 1 transition).

        Starts the periodic flush timer for this flow.  A task already running
        (e.g. from a race) is cancelled and replaced.
        """
        existing = self._tasks.get(flow_id)
        if existing is not None and not existing.done():
            existing.cancel()
        task = asyncio.create_task(self._run(flow_id))
        self._tasks[flow_id] = task
        logger.info("flush_coordinator: timer started for flow={}", flow_id)

    async def on_room_empty(self, flow_id: int) -> None:
        """Called when the last member leaves (count → 0 after SREM).

        Re-checks the Redis member count before acting.  A concurrent ``join``
        may have incremented the count between the caller's SREM and this
        method executing, in which case the room is no longer empty and we
        must leave the timer running and skip GC entirely.

        Only when the count is still 0 does this method cancel the timer and
        GC the live document from Redis.
        """
        current = await self._presence.member_count(flow_id)
        if current > 0:
            logger.info(
                "flush_coordinator: on_room_empty skipped for flow={} "
                "(re-check count={}, concurrent join detected)",
                flow_id,
                current,
            )
            return

        task = self._tasks.pop(flow_id, None)
        if task is not None and not task.done():
            task.cancel()
            logger.info("flush_coordinator: timer cancelled for flow={}", flow_id)

        # GC the live document — room is truly empty.
        await self._live_doc_repo.clear_flow(flow_id)
        logger.info("flush_coordinator: GC complete for flow={}", flow_id)

    # ------------------------------------------------------------------
    # Internal timer loop
    # ------------------------------------------------------------------

    async def _run(self, flow_id: int) -> None:
        """Timer loop for a single flow.  Exits cleanly on cancellation."""
        try:
            while True:
                await self._sleep(self._interval)
                await self._tick(flow_id)
        except asyncio.CancelledError:
            logger.debug("flush_coordinator: _run cancelled for flow={}", flow_id)
            raise

    async def _sleep(self, seconds: float) -> None:
        """Injectable sleep — subclasses or tests may override."""
        await asyncio.sleep(seconds)

    async def _tick(self, flow_id: int) -> None:
        """Send a ``flush_requested`` frame to the designated socket.

        Does NOT clear Redis — the flow is still active.
        """
        socket = self._presence.designated_socket(flow_id)
        if socket is None:
            logger.debug(
                "flush_coordinator: no designated socket for flow={}, skipping tick",
                flow_id,
            )
            return

        payload = {
            "type": "flush_requested",
            "flow_id": flow_id,
            "reason": "periodic",
        }
        await self._registry.send_to(socket, payload)
        logger.info(
            "flush_coordinator: flush_requested sent to designated socket flow={}",
            flow_id,
        )
