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
    """

    def __init__(
        self, repository: PresenceRepository, registry: CollabSocketRegistry
    ) -> None:
        self._repository = repository
        self._registry = registry

    async def join(self, flow_id: int, websocket: WebSocket) -> str:
        """Register a new connection for flow_id.

        Returns the opaque member_id (uuid4 hex) assigned to this connection.
        Broadcasts the updated count to all connections on the flow.
        """
        member_id = uuid.uuid4().hex

        # Redis write first: if it fails, the socket is never registered locally
        # so there is no local/Redis count mismatch.
        await self._repository.add_member(flow_id, member_id)

        self._registry.register(flow_id, websocket)

        await self._broadcast(flow_id)

        logger.info("presence JOIN flow={} member={}", flow_id, member_id)
        return member_id

    async def leave(self, flow_id: int, websocket: WebSocket, member_id: str) -> None:
        """Deregister a connection for flow_id.

        Broadcasts the decremented count to all remaining connections.
        Safe to call even if the socket was already removed.
        """
        self._registry.unregister(flow_id, websocket)

        await self._repository.remove_member(flow_id, member_id)
        await self._broadcast(flow_id)

        logger.info("presence LEAVE flow={} member={}", flow_id, member_id)

    async def _broadcast(self, flow_id: int) -> None:
        """SCARD the flow's Redis set and fan-out to all live sockets."""
        count = await self._repository.count(flow_id)
        payload = {"type": "presence", "flow_id": flow_id, "count": count}
        await self._registry.broadcast_json(flow_id, payload)
