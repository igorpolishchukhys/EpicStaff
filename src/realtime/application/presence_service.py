import uuid
from fastapi import WebSocket
from loguru import logger

from application.collab_socket_registry import CollabSocketRegistry
from infrastructure.persistence.presence_repository import PresenceRepository


class PresenceService:
    """Manages per-flow WebSocket presence.

    Delegates socket fan-out to ``CollabSocketRegistry`` so the registry
    is the single source of truth for live connections (shared with
    ``LiveDocumentService``).

    Redis presence SET (``presence:flow:{flow_id}``) is the durable count
    store so that the count survives across service restarts and reflects
    exactly the connections registered in this process.

    Public join/leave semantics and the presence message shape are frozen
    by the EST-2 tests — do not change them.

    EST-3: identity tracking added.  Each connection carries
    ``{"user_id": int, "display_name": str | None}``.  The broadcast
    payload gains a ``participants`` list — one entry per live socket
    (frontend deduplicates by user_id to build the avatar stack).
    """

    def __init__(
        self, repository: PresenceRepository, registry: CollabSocketRegistry
    ) -> None:
        self._repository = repository
        self._registry = registry
        # Maps websocket → {"user_id": int, "display_name": str | None}
        self._identity: dict[WebSocket, dict] = {}
        # Wire registry to call _forget for any socket dropped during broadcast.
        self._registry.set_on_drop(self._forget)

    def _forget(self, websocket: WebSocket) -> None:
        """Remove identity tracking for a socket dropped by the registry."""
        self._identity.pop(websocket, None)

    async def join(
        self,
        flow_id: int,
        websocket: WebSocket,
        user_id: int,
        display_name: str | None = None,
    ) -> str:
        """Register a new connection for flow_id.

        Returns the opaque member_id (uuid4 hex) assigned to this connection.
        Broadcasts the updated count and participant list to all connections
        on the flow.
        """
        member_id = uuid.uuid4().hex

        # Redis write first: if it fails, the socket is never registered locally
        # so there is no local/Redis count mismatch.
        await self._repository.add_member(flow_id, member_id)

        self._registry.register(flow_id, websocket)
        self._identity[websocket] = {"user_id": user_id, "display_name": display_name}

        await self._broadcast(flow_id)

        logger.info("presence JOIN flow={} member={}", flow_id, member_id)
        return member_id

    async def leave(self, flow_id: int, websocket: WebSocket, member_id: str) -> None:
        """Deregister a connection for flow_id.

        Broadcasts the decremented count to all remaining connections.
        Safe to call even if the socket was already removed.
        """
        self._registry.unregister(flow_id, websocket)
        self._identity.pop(websocket, None)

        await self._repository.remove_member(flow_id, member_id)
        await self._broadcast(flow_id)

        logger.info("presence LEAVE flow={} member={}", flow_id, member_id)

    async def _broadcast(self, flow_id: int) -> None:
        """SCARD the flow's Redis set and fan-out to all live sockets."""
        count = await self._repository.count(flow_id)

        # Build participants from the live sockets for this flow.
        participants = [
            self._identity[ws]
            for ws in self._registry.sockets_for(flow_id)
            if ws in self._identity
        ]

        payload = {
            "type": "presence",
            "flow_id": flow_id,
            "count": count,
            "participants": participants,
        }
        await self._registry.broadcast_json(flow_id, payload)
