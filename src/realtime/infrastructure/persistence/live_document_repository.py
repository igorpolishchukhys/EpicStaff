import json

from loguru import logger

from infrastructure.messaging.redis_service import RedisService


class LiveDocumentRepository:
    """Redis HASH adapter for per-flow node position state.

    Key schema: ``collab:flow:{flow_id}:positions``
    Fields:     str(node_id)
    Values:     JSON-encoded ``{"x": <number>, "y": <number>}``

    The hash is NOT cleared on last exit — lifecycle (flush) is owned by a
    separate slice.
    """

    def __init__(self, redis_service: RedisService) -> None:
        self._redis = redis_service

    def _key(self, flow_id: int) -> str:
        return f"collab:flow:{flow_id}:positions"

    async def set_position(
        self, flow_id: int, node_id: int, x: float, y: float
    ) -> None:
        """HSET the node position (last-write-wins)."""
        value = json.dumps({"x": x, "y": y})
        await self._redis.aioredis_client.hset(self._key(flow_id), str(node_id), value)
        logger.debug("live_doc HSET flow={} node={} x={} y={}", flow_id, node_id, x, y)

    async def get_all_positions(self, flow_id: int) -> dict[str, dict]:
        """Return all node positions as ``{str(node_id): {"x": ..., "y": ...}}``."""
        raw: dict[str, str] = await self._redis.aioredis_client.hgetall(
            self._key(flow_id)
        )
        result: dict[str, dict] = {}
        for field, value in raw.items():
            try:
                result[field] = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "live_doc: corrupt position value for flow={} node={}, skipping",
                    flow_id,
                    field,
                )
        return result
