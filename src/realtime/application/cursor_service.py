from loguru import logger

from application.collab_socket_registry import CollabSocketRegistry


class CursorService:
    """Ephemeral relay for cursor and selection events.

    Both operations are in-process fan-out only — no Redis reads or writes.
    Outbound frames are broadcast to ALL sockets on the flow, including the sender
    (clients filter by ``origin`` to suppress their own echo if desired).
    """

    def __init__(self, registry: CollabSocketRegistry) -> None:
        self._registry = registry

    async def relay_cursor(
        self,
        flow_id: int,
        x: float,
        y: float,
        origin_member_id: str,
        user_id: int,
    ) -> None:
        """Broadcast a cursor_moved frame to all sockets on the flow.

        Outbound shape (frozen contract):
            {"type": "cursor_moved", "flow_id": <int>, "x": <float>, "y": <float>,
             "origin": "<member_id>", "user_id": <int>}
        """
        payload = {
            "type": "cursor_moved",
            "flow_id": flow_id,
            "x": x,
            "y": y,
            "origin": origin_member_id,
            "user_id": user_id,
        }
        await self._registry.broadcast_json(flow_id, payload)
        logger.debug(
            "cursor RELAY flow={} x={} y={} origin={}",
            flow_id,
            x,
            y,
            origin_member_id,
        )

    async def relay_selection(
        self,
        flow_id: int,
        node_ids: list[int],
        origin_member_id: str,
        user_id: int,
    ) -> None:
        """Broadcast a selection_changed frame to all sockets on the flow.

        Outbound shape (frozen contract):
            {"type": "selection_changed", "flow_id": <int>, "node_ids": [<int>, ...],
             "origin": "<member_id>", "user_id": <int>}
        """
        payload = {
            "type": "selection_changed",
            "flow_id": flow_id,
            "node_ids": node_ids,
            "origin": origin_member_id,
            "user_id": user_id,
        }
        await self._registry.broadcast_json(flow_id, payload)
        logger.debug(
            "selection RELAY flow={} node_ids={} origin={}",
            flow_id,
            node_ids,
            origin_member_id,
        )
