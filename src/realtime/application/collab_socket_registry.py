import json
from collections.abc import Callable

from fastapi import WebSocket
from loguru import logger


class CollabSocketRegistry:
    """In-process registry of live WebSocket connections per flow.

    Provides registration, unregistration, and fan-out broadcast for all
    collab sockets (presence *and* live-document).  A single instance is
    shared across ``PresenceService`` and ``LiveDocumentService`` so that
    both use the same source of truth.

    Any number of ``on_drop`` callbacks may be registered via ``add_on_drop``.
    Each one is called once for every dead socket removed during
    ``broadcast_json``, allowing ``PresenceService`` to purge its
    ``_identity`` map and ``LockService`` cleanup to release the dropped
    holder's locks (EST-9) without the registry importing any
    application-layer type.
    """

    def __init__(self) -> None:
        self._sockets: dict[int, set[WebSocket]] = {}
        self._on_drop_callbacks: list[Callable[[WebSocket], None]] = []

    def add_on_drop(self, callback: Callable[[WebSocket], None]) -> None:
        """Register a callback that fires for each dead socket dropped during broadcast."""
        self._on_drop_callbacks.append(callback)

    def register(self, flow_id: int, websocket: WebSocket) -> None:
        """Add ``websocket`` to the registry for ``flow_id``."""
        if flow_id not in self._sockets:
            self._sockets[flow_id] = set()
        self._sockets[flow_id].add(websocket)

    def unregister(self, flow_id: int, websocket: WebSocket) -> None:
        """Remove ``websocket`` from the registry for ``flow_id``.

        Safe to call even when the socket is not present.
        """
        flow_sockets = self._sockets.get(flow_id)
        if flow_sockets is not None:
            flow_sockets.discard(websocket)
            if not flow_sockets:
                del self._sockets[flow_id]

    def sockets_for(self, flow_id: int) -> set[WebSocket]:
        """Return the current set of sockets for ``flow_id`` (may be empty)."""
        return set(self._sockets.get(flow_id, set()))

    async def broadcast_json(self, flow_id: int, payload: dict) -> None:
        """Serialise ``payload`` to JSON and send to every socket on ``flow_id``.

        Dead sockets are silently dropped from the registry.
        """
        message = json.dumps(payload)
        flow_sockets = list(self._sockets.get(flow_id, set()))
        dead: list[WebSocket] = []

        for ws in flow_sockets:
            try:
                await ws.send_text(message)
            except Exception:
                logger.warning(
                    "collab registry: dead socket on flow={}, removing", flow_id
                )
                dead.append(ws)

        if dead:
            surviving = self._sockets.get(flow_id)
            if surviving is not None:
                for ws in dead:
                    surviving.discard(ws)
                    for callback in self._on_drop_callbacks:
                        callback(ws)
                if not surviving:
                    del self._sockets[flow_id]
