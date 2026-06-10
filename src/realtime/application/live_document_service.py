from loguru import logger

from application.collab_socket_registry import CollabSocketRegistry
from infrastructure.persistence.live_document_repository import LiveDocumentRepository


class LiveDocumentService:
    """Coordinates node-position state for the shared live document.

    Persists moves to Redis (last-write-wins HSET) and broadcasts the
    outbound rebroadcast frame to ALL sockets on the flow, including the
    sender (clients echo-filter by ``origin``).
    """

    def __init__(
        self,
        registry: CollabSocketRegistry,
        repository: LiveDocumentRepository,
    ) -> None:
        self._registry = registry
        self._repository = repository

    async def apply_node_move(
        self,
        flow_id: int,
        node_id: int,
        x: float,
        y: float,
        origin_member_id: str,
    ) -> None:
        """Persist the move and broadcast to all sockets on the flow.

        Outbound shape (frozen contract):
            {"type": "node_moved", "flow_id": <int>, "node_id": <int>,
             "x": <number>, "y": <number>, "origin": "<member_id>"}
        """
        await self._repository.set_position(flow_id, node_id, x, y)

        payload = {
            "type": "node_moved",
            "flow_id": flow_id,
            "node_id": node_id,
            "x": x,
            "y": y,
            "origin": origin_member_id,
        }
        await self._registry.broadcast_json(flow_id, payload)
        logger.debug(
            "live_doc MOVE flow={} node={} x={} y={} origin={}",
            flow_id,
            node_id,
            x,
            y,
            origin_member_id,
        )

    async def get_document_state(self, flow_id: int) -> dict:
        """Return the current node-position snapshot for a flow.

        Return shape (frozen contract):
            {"type": "document_state", "flow_id": <int>,
             "positions": {"<node_id>": {"x": ..., "y": ...}}}

        Returns an empty ``positions`` dict when no moves have been recorded.
        """
        positions = await self._repository.get_all_positions(flow_id)
        return {
            "type": "document_state",
            "flow_id": flow_id,
            "positions": positions,
        }
