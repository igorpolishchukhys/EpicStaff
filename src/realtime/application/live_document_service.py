from loguru import logger

from application.collab_socket_registry import CollabSocketRegistry
from infrastructure.persistence.live_document_repository import LiveDocumentRepository

# Increment this constant whenever the document_state payload shape changes in a
# backwards-incompatible way.  Clients use it to detect format mismatches.
_DOCUMENT_STATE_SCHEMA_VERSION = 2


class LiveDocumentService:
    """Coordinates the shared live document for a flow: positions, nodes, and connections.

    All mutations persist to Redis (last-write-wins HSET) and broadcast the
    outbound frame to ALL sockets on the flow, including the sender.
    Clients echo-filter by the ``origin`` field.
    """

    def __init__(
        self,
        registry: CollabSocketRegistry,
        repository: LiveDocumentRepository,
    ) -> None:
        self._registry = registry
        self._repository = repository

    # ------------------------------------------------------------------
    # Positions (unchanged)
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Structural — nodes
    # ------------------------------------------------------------------

    async def apply_node_added(
        self,
        flow_id: int,
        node_key: str,
        node: dict,
        origin_member_id: str,
    ) -> None:
        """Persist the node and broadcast to all sockets on the flow.

        Add-exists guard: if ``node_key`` already has a live record this call
        is a no-op (idempotent).

        Outbound shape (frozen contract):
            {"type": "node_added", "flow_id": <int>,
             "node_key": "<str>", "node": {...}, "origin": "<member_id>"}
        """
        if await self._repository.node_exists(flow_id, node_key):
            logger.debug(
                "live_doc add_node no-op (already exists) flow={} node_key={}",
                flow_id,
                node_key,
            )
            return

        # Clear any stale tombstone for this key.  A save→delete→re-add cycle
        # on the same node_key would otherwise leave the key in both `nodes`
        # and `tombstones`, causing late joiners to see a contradictory state.
        await self._repository.remove_node_tombstone(flow_id, node_key)
        await self._repository.add_node(flow_id, node_key, node)

        payload = {
            "type": "node_added",
            "flow_id": flow_id,
            "node_key": node_key,
            "node": node,
            "origin": origin_member_id,
        }
        await self._registry.broadcast_json(flow_id, payload)
        logger.debug(
            "live_doc NODE_ADDED flow={} node_key={} origin={}",
            flow_id,
            node_key,
            origin_member_id,
        )

    async def apply_node_deleted(
        self,
        flow_id: int,
        node_key: str,
        origin_member_id: str,
    ) -> None:
        """Delete the node, cascade-delete its connections, write tombstones, and broadcast.

        Delete-missing guard: if ``node_key`` has no live record this call is a
        no-op (idempotent).

        The SERVER computes orphaned connections via
        ``get_connections_for_node`` and the broadcast carries the full
        ``removed_connection_ids`` list so clients do not recompute orphans.

        Outbound shape (frozen contract):
            {"type": "node_deleted", "flow_id": <int>,
             "node_key": "<str>",
             "removed_connection_ids": ["<str>", ...],
             "origin": "<member_id>"}
        """
        if not await self._repository.node_exists(flow_id, node_key):
            logger.debug(
                "live_doc delete_node no-op (not found) flow={} node_key={}",
                flow_id,
                node_key,
            )
            return

        # Cascade: find and remove all connections attached to this node.
        orphaned_ids = await self._repository.get_connections_for_node(
            flow_id, node_key
        )
        for connection_id in orphaned_ids:
            await self._repository.remove_connection(flow_id, connection_id)
            await self._repository.add_connection_tombstone(flow_id, connection_id)

        await self._repository.remove_node(flow_id, node_key)
        await self._repository.add_node_tombstone(flow_id, node_key)

        payload = {
            "type": "node_deleted",
            "flow_id": flow_id,
            "node_key": node_key,
            "removed_connection_ids": orphaned_ids,
            "origin": origin_member_id,
        }
        await self._registry.broadcast_json(flow_id, payload)
        logger.debug(
            "live_doc NODE_DELETED flow={} node_key={} cascaded={} origin={}",
            flow_id,
            node_key,
            orphaned_ids,
            origin_member_id,
        )

    # ------------------------------------------------------------------
    # Structural — connections
    # ------------------------------------------------------------------

    async def apply_connection_added(
        self,
        flow_id: int,
        connection_id: str,
        source_node_key: str,
        target_node_key: str,
        source_port_id: str,
        target_port_id: str,
        connection: dict,
        origin_member_id: str,
    ) -> None:
        """Persist the connection and broadcast to all sockets on the flow.

        Endpoint guard: if EITHER endpoint node_key has no live node record
        this frame is dropped silently (the client will receive a full
        document_state resync to recover).

        Outbound shape (frozen contract):
            {"type": "connection_added", "flow_id": <int>,
             "connection_id": "<str>",
             "source_node_key": "<str>", "target_node_key": "<str>",
             "source_port_id": "<str>", "target_port_id": "<str>",
             "connection": {...}, "origin": "<member_id>"}
        """
        if not await self._repository.node_exists(flow_id, source_node_key):
            logger.warning(
                "live_doc connection_added DROPPED: source_node_key={} not found "
                "flow={} connection_id={}",
                source_node_key,
                flow_id,
                connection_id,
            )
            return

        if not await self._repository.node_exists(flow_id, target_node_key):
            logger.warning(
                "live_doc connection_added DROPPED: target_node_key={} not found "
                "flow={} connection_id={}",
                target_node_key,
                flow_id,
                connection_id,
            )
            return

        if await self._repository.connection_exists(flow_id, connection_id):
            logger.debug(
                "live_doc connection_added no-op (already exists) flow={} connection_id={}",
                flow_id,
                connection_id,
            )
            return

        # Clear any stale tombstone for this connection_id.  A
        # add→remove→re-add cycle on the same connection_id would otherwise
        # leave it in both `connections` and `tombstones` for late joiners.
        await self._repository.remove_connection_tombstone(flow_id, connection_id)
        await self._repository.add_connection(
            flow_id,
            connection_id,
            source_node_key,
            target_node_key,
            source_port_id,
            target_port_id,
            connection,
        )

        payload = {
            "type": "connection_added",
            "flow_id": flow_id,
            "connection_id": connection_id,
            "source_node_key": source_node_key,
            "target_node_key": target_node_key,
            "source_port_id": source_port_id,
            "target_port_id": target_port_id,
            "connection": connection,
            "origin": origin_member_id,
        }
        await self._registry.broadcast_json(flow_id, payload)
        logger.debug(
            "live_doc CONNECTION_ADDED flow={} connection_id={} origin={}",
            flow_id,
            connection_id,
            origin_member_id,
        )

    async def apply_connection_removed(
        self,
        flow_id: int,
        connection_id: str,
        origin_member_id: str,
    ) -> None:
        """Remove the connection, write a tombstone, and broadcast.

        Remove-missing guard: if ``connection_id`` is not present this call is
        a no-op (idempotent).

        Outbound shape (frozen contract):
            {"type": "connection_removed", "flow_id": <int>,
             "connection_id": "<str>", "origin": "<member_id>"}
        """
        if not await self._repository.connection_exists(flow_id, connection_id):
            logger.debug(
                "live_doc remove_connection no-op (not found) flow={} connection_id={}",
                flow_id,
                connection_id,
            )
            return

        await self._repository.remove_connection(flow_id, connection_id)
        await self._repository.add_connection_tombstone(flow_id, connection_id)

        payload = {
            "type": "connection_removed",
            "flow_id": flow_id,
            "connection_id": connection_id,
            "origin": origin_member_id,
        }
        await self._registry.broadcast_json(flow_id, payload)
        logger.debug(
            "live_doc CONNECTION_REMOVED flow={} connection_id={} origin={}",
            flow_id,
            connection_id,
            origin_member_id,
        )

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------

    async def get_document_state(self, flow_id: int) -> dict:
        """Return the full live-document snapshot for a late-joining client.

        Return shape (frozen contract):
            {
              "type": "document_state",
              "flow_id": <int>,
              "schema_version": 2,
              "positions": {"<node_id>": {"x": ..., "y": ...}},
              "nodes": {"<node_key>": {...}},
              "connections": {
                "<connection_id>": {
                  "source_node_key": str,
                  "target_node_key": str,
                  "source_port_id": str,
                  "target_port_id": str,
                  "connection": {...}
                }
              },
              "tombstones": {"node:<node_key>": "1", "conn:<connection_id>": "1", ...}
            }

        All sub-dicts are empty when no structural operations have been
        recorded yet.  ``positions`` is preserved unchanged for backward
        compatibility.
        """
        positions = await self._repository.get_all_positions(flow_id)
        nodes = await self._repository.get_all_nodes(flow_id)
        connections = await self._repository.get_all_connections(flow_id)
        tombstones = await self._repository.get_tombstones(flow_id)
        return {
            "type": "document_state",
            "flow_id": flow_id,
            "schema_version": _DOCUMENT_STATE_SCHEMA_VERSION,
            "positions": positions,
            "nodes": nodes,
            "connections": connections,
            "tombstones": tombstones,
        }
