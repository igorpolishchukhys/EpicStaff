import json

from loguru import logger

from infrastructure.messaging.redis_service import RedisService


class LiveDocumentRepository:
    """Redis HASH adapter for the per-flow shared live document.

    Key schema
    ----------
    ``collab:flow:{flow_id}:positions``
        HASH — field str(node_id) → JSON ``{"x": <number>, "y": <number>}``
        (original int-keyed position state; unchanged).

    ``collab:flow:{flow_id}:nodes``
        HASH — field node_key (str) → JSON opaque NodeModel payload.

    ``collab:flow:{flow_id}:connections``
        HASH — field connection_id (str) → JSON
        ``{"source_node_key": str, "target_node_key": str,
           "source_port_id": str, "target_port_id": str, "connection": dict}``.
        Both endpoint node_keys are stored here so the server can compute
        orphaned connections on node delete (cascade authority).

    ``collab:flow:{flow_id}:tombstones``
        HASH — field tombstone_key (str) → "1".
        Tombstone keys are prefixed: ``node:<node_key>`` and
        ``conn:<connection_id>`` to keep a single hash per flow.

    None of these hashes are cleared on last-client-exit — GC is a later
    slice (mirrors the existing positions behaviour).
    """

    def __init__(self, redis_service: RedisService) -> None:
        self._redis = redis_service

    # ------------------------------------------------------------------
    # Key helpers
    # ------------------------------------------------------------------

    def _positions_key(self, flow_id: int) -> str:
        return f"collab:flow:{flow_id}:positions"

    def _nodes_key(self, flow_id: int) -> str:
        return f"collab:flow:{flow_id}:nodes"

    def _connections_key(self, flow_id: int) -> str:
        return f"collab:flow:{flow_id}:connections"

    def _tombstones_key(self, flow_id: int) -> str:
        return f"collab:flow:{flow_id}:tombstones"

    # ------------------------------------------------------------------
    # Positions (unchanged public API)
    # ------------------------------------------------------------------

    async def set_position(
        self, flow_id: int, node_id: int, x: float, y: float
    ) -> None:
        """HSET the node position (last-write-wins)."""
        value = json.dumps({"x": x, "y": y})
        await self._redis.aioredis_client.hset(
            self._positions_key(flow_id), str(node_id), value
        )
        logger.debug("live_doc HSET flow={} node={} x={} y={}", flow_id, node_id, x, y)

    async def get_all_positions(self, flow_id: int) -> dict[str, dict]:
        """Return all node positions as ``{str(node_id): {"x": ..., "y": ...}}``."""
        raw: dict[str, str] = await self._redis.aioredis_client.hgetall(
            self._positions_key(flow_id)
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

    # ------------------------------------------------------------------
    # Nodes
    # ------------------------------------------------------------------

    async def add_node(self, flow_id: int, node_key: str, node: dict) -> None:
        """HSET the node payload under ``node_key`` (last-write-wins)."""
        await self._redis.aioredis_client.hset(
            self._nodes_key(flow_id), node_key, json.dumps(node)
        )
        logger.debug("live_doc add_node flow={} node_key={}", flow_id, node_key)

    async def remove_node(self, flow_id: int, node_key: str) -> None:
        """HDEL the node entry.  No-op when the field does not exist."""
        await self._redis.aioredis_client.hdel(self._nodes_key(flow_id), node_key)
        logger.debug("live_doc remove_node flow={} node_key={}", flow_id, node_key)

    async def get_all_nodes(self, flow_id: int) -> dict[str, dict]:
        """Return all nodes as ``{node_key: <opaque node dict>}``."""
        raw: dict[str, str] = await self._redis.aioredis_client.hgetall(
            self._nodes_key(flow_id)
        )
        result: dict[str, dict] = {}
        for field, value in raw.items():
            try:
                result[field] = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "live_doc: corrupt node value for flow={} node_key={}, skipping",
                    flow_id,
                    field,
                )
        return result

    async def node_exists(self, flow_id: int, node_key: str) -> bool:
        """Return True when ``node_key`` has a live record in this flow."""
        return bool(
            await self._redis.aioredis_client.hexists(
                self._nodes_key(flow_id), node_key
            )
        )

    # ------------------------------------------------------------------
    # Connections
    # ------------------------------------------------------------------

    async def add_connection(
        self,
        flow_id: int,
        connection_id: str,
        source_node_key: str,
        target_node_key: str,
        source_port_id: str,
        target_port_id: str,
        connection: dict,
    ) -> None:
        """HSET the connection record (last-write-wins)."""
        value = json.dumps(
            {
                "source_node_key": source_node_key,
                "target_node_key": target_node_key,
                "source_port_id": source_port_id,
                "target_port_id": target_port_id,
                "connection": connection,
            }
        )
        await self._redis.aioredis_client.hset(
            self._connections_key(flow_id), connection_id, value
        )
        logger.debug(
            "live_doc add_connection flow={} connection_id={}",
            flow_id,
            connection_id,
        )

    async def remove_connection(self, flow_id: int, connection_id: str) -> None:
        """HDEL the connection entry.  No-op when the field does not exist."""
        await self._redis.aioredis_client.hdel(
            self._connections_key(flow_id), connection_id
        )
        logger.debug(
            "live_doc remove_connection flow={} connection_id={}",
            flow_id,
            connection_id,
        )

    async def connection_exists(self, flow_id: int, connection_id: str) -> bool:
        """Return True when ``connection_id`` has a live record in this flow."""
        return bool(
            await self._redis.aioredis_client.hexists(
                self._connections_key(flow_id), connection_id
            )
        )

    async def get_connections_for_node(self, flow_id: int, node_key: str) -> list[str]:
        """Return all connection_ids whose source or target equals ``node_key``.

        Used by the server-side delete cascade when a node is removed.

        NOTE: This is an O(N) full hash scan over all connections in the flow.
        Acceptable at current scale (flows have tens to low hundreds of
        connections).  If flows grow into the thousands, add a secondary index
        keyed by node_key so this lookup is O(1).
        """
        raw: dict[str, str] = await self._redis.aioredis_client.hgetall(
            self._connections_key(flow_id)
        )
        orphaned: list[str] = []
        for connection_id, value in raw.items():
            try:
                record = json.loads(value)
                if (
                    record.get("source_node_key") == node_key
                    or record.get("target_node_key") == node_key
                ):
                    orphaned.append(connection_id)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "live_doc: corrupt connection value for flow={} connection_id={}, skipping",
                    flow_id,
                    connection_id,
                )
        return orphaned

    async def get_all_connections(self, flow_id: int) -> dict[str, dict]:
        """Return all connections as ``{connection_id: <record dict>}``."""
        raw: dict[str, str] = await self._redis.aioredis_client.hgetall(
            self._connections_key(flow_id)
        )
        result: dict[str, dict] = {}
        for field, value in raw.items():
            try:
                result[field] = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "live_doc: corrupt connection value for flow={} connection_id={}, skipping",
                    flow_id,
                    field,
                )
        return result

    # ------------------------------------------------------------------
    # Tombstones
    # ------------------------------------------------------------------

    async def add_node_tombstone(self, flow_id: int, node_key: str) -> None:
        """Mark ``node_key`` as deleted in the tombstone hash."""
        await self._redis.aioredis_client.hset(
            self._tombstones_key(flow_id), f"node:{node_key}", "1"
        )
        logger.debug("live_doc tombstone node flow={} node_key={}", flow_id, node_key)

    async def remove_node_tombstone(self, flow_id: int, node_key: str) -> None:
        """HDEL the ``node:<node_key>`` tombstone entry.  No-op when absent."""
        await self._redis.aioredis_client.hdel(
            self._tombstones_key(flow_id), f"node:{node_key}"
        )
        logger.debug(
            "live_doc remove_tombstone node flow={} node_key={}", flow_id, node_key
        )

    async def add_connection_tombstone(self, flow_id: int, connection_id: str) -> None:
        """Mark ``connection_id`` as deleted in the tombstone hash."""
        await self._redis.aioredis_client.hset(
            self._tombstones_key(flow_id), f"conn:{connection_id}", "1"
        )
        logger.debug(
            "live_doc tombstone conn flow={} connection_id={}",
            flow_id,
            connection_id,
        )

    async def remove_connection_tombstone(
        self, flow_id: int, connection_id: str
    ) -> None:
        """HDEL the ``conn:<connection_id>`` tombstone entry.  No-op when absent."""
        await self._redis.aioredis_client.hdel(
            self._tombstones_key(flow_id), f"conn:{connection_id}"
        )
        logger.debug(
            "live_doc remove_tombstone conn flow={} connection_id={}",
            flow_id,
            connection_id,
        )

    async def get_tombstones(self, flow_id: int) -> dict[str, str]:
        """Return all tombstone entries as ``{tombstone_key: "1"}``."""
        return await self._redis.aioredis_client.hgetall(self._tombstones_key(flow_id))
