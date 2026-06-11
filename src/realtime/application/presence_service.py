from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from fastapi import WebSocket
from loguru import logger

from application.collab_socket_registry import CollabSocketRegistry
from infrastructure.persistence.presence_repository import PresenceRepository

if TYPE_CHECKING:
    from application.flush_coordinator import FlushCoordinator


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

    EST-7: insertion-ordered join tracking added.  Each flow maintains
    an ordered list of member_ids.  The oldest-joined member still
    connected is the *designated client* that receives periodic
    ``flush_requested`` frames.  The broadcast payload gains a
    ``designated_member_id`` field (str | None) so every client knows
    who is currently designated.
    """

    def __init__(
        self,
        repository: PresenceRepository,
        registry: CollabSocketRegistry,
        flush_coordinator: "FlushCoordinator | None" = None,
    ) -> None:
        self._repository = repository
        self._registry = registry
        self._flush_coordinator: "FlushCoordinator | None" = flush_coordinator
        # Maps websocket → {"user_id": int, "display_name": str | None}
        self._identity: dict[WebSocket, dict] = {}
        # Maps member_id → websocket (for designated-socket lookup)
        self._member_socket: dict[str, WebSocket] = {}
        # Insertion-ordered join list per flow: flow_id → [member_id, ...]
        # Using dict[str, ...] to preserve insertion order (Python 3.7+).
        self._join_order: dict[int, list[str]] = {}
        # Reverse map: member_id → flow_id, so _forget can look up the flow
        # directly instead of scanning all _join_order values (O(1) vs O(N)).
        self._member_flow: dict[str, int] = {}
        # Wire registry to call _forget for any socket dropped during broadcast.
        self._registry.add_on_drop(self._forget)

    def set_flush_coordinator(self, flush_coordinator: "FlushCoordinator") -> None:
        """Inject the flush coordinator after construction (breaks circular dep)."""
        self._flush_coordinator = flush_coordinator

    def _forget(self, websocket: WebSocket) -> None:
        """Remove identity and join-order tracking for a dropped socket."""
        self._identity.pop(websocket, None)
        # Remove the member_id that mapped to this socket.
        stale_members = [
            mid for mid, ws in self._member_socket.items() if ws is websocket
        ]
        for mid in stale_members:
            self._member_socket.pop(mid, None)
            # Use the reverse map for O(1) flow lookup instead of scanning all
            # _join_order values.
            flow_id = self._member_flow.pop(mid, None)
            if flow_id is not None:
                order_list = self._join_order.get(flow_id)
                if order_list is not None and mid in order_list:
                    order_list.remove(mid)

    async def member_count(self, flow_id: int) -> int:
        """Return the Redis-authoritative member count for the given flow."""
        return await self._repository.count(flow_id)

    def designated_member_id(self, flow_id: int) -> str | None:
        """Return the member_id of the oldest-joined member still connected.

        Returns None when the flow has no connected members.
        """
        order = self._join_order.get(flow_id)
        if not order:
            return None
        return order[0]

    def designated_socket(self, flow_id: int) -> WebSocket | None:
        """Return the WebSocket of the designated member, or None."""
        member_id = self.designated_member_id(flow_id)
        if member_id is None:
            return None
        return self._member_socket.get(member_id)

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
        self._member_socket[member_id] = websocket

        # Insertion-ordered join tracking.
        if flow_id not in self._join_order:
            self._join_order[flow_id] = []
        was_empty = len(self._join_order[flow_id]) == 0
        self._join_order[flow_id].append(member_id)
        # Reverse map so _forget can look up the flow without scanning.
        self._member_flow[member_id] = flow_id

        await self._broadcast(flow_id)

        # Notify the flush coordinator that the room is now active (0 → 1).
        if was_empty and self._flush_coordinator is not None:
            self._flush_coordinator.on_room_active(flow_id)

        logger.info("presence JOIN flow={} member={}", flow_id, member_id)
        return member_id

    async def leave(self, flow_id: int, websocket: WebSocket, member_id: str) -> None:
        """Deregister a connection for flow_id.

        Broadcasts the decremented count to all remaining connections.
        Safe to call even if the socket was already removed.
        """
        self._registry.unregister(flow_id, websocket)
        self._identity.pop(websocket, None)
        self._member_socket.pop(member_id, None)
        self._member_flow.pop(member_id, None)

        # Remove from join order.
        order = self._join_order.get(flow_id)
        if order is not None and member_id in order:
            order.remove(member_id)
        # Clean up empty order lists.
        if order is not None and len(order) == 0:
            del self._join_order[flow_id]

        await self._repository.remove_member(flow_id, member_id)

        # Check count after SREM so we gate on the Redis-authoritative value.
        count = await self._repository.count(flow_id)

        await self._broadcast(flow_id)

        # Notify the flush coordinator when the last member left (count → 0).
        if count == 0 and self._flush_coordinator is not None:
            await self._flush_coordinator.on_room_empty(flow_id)

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
            "designated_member_id": self.designated_member_id(flow_id),
        }
        await self._registry.broadcast_json(flow_id, payload)
