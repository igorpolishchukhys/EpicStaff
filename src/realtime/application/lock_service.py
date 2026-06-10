from fastapi import WebSocket
from loguru import logger

from application.collab_socket_registry import CollabSocketRegistry


class LockService:
    """Exclusive node-panel lock manager (EST-8).

    Maintains an in-memory mapping of flow → node → {member_id, user_id} so
    that only one member at a time can edit a node panel.  All state is
    process-local — no Redis reads or writes.

    The ``websocket`` passed to ``acquire`` is used only for the direct
    ``lock_granted`` / ``lock_denied`` reply; it is not stored in the lock
    entry.

    Disconnect cleanup (EST-9): ``release_all_for_member`` releases every
    lock held by a dropped connection.  It is invoked from the collab
    endpoint's ``finally`` block (the single cleanup path for both
    protocol-detected disconnects and heartbeat-sweep force-closes) and,
    belt-and-braces, from the registry's on_drop seam.

    Inbound / outbound frame contracts are frozen by the EST-8 spec and are
    reproduced here for reference:

    Acquire path
    ------------
    Requester only (send_json):
        {"type": "lock_granted", "flow_id": <int>, "node_id": <int>}
        {"type": "lock_denied",  "flow_id": <int>, "node_id": <int>,
         "holder_user_id": <int>}

    Broadcast (all sockets on the flow, including sender):
        {"type": "node_locked", "flow_id": <int>, "node_id": <int>,
         "origin": "<member_id>", "user_id": <int>}

    Release path
    ------------
    Broadcast (all sockets on the flow, including sender):
        {"type": "node_unlocked", "flow_id": <int>, "node_id": <int>,
         "origin": "<member_id>"}

    Auto-release on disconnect (EST-9) extends the broadcast additively —
    ``reason`` is present ONLY on auto-release; manual release is unchanged:
        {"type": "node_unlocked", "flow_id": <int>, "node_id": <int>,
         "origin": "<dropped holder member_id>", "reason": "disconnected"}

    Lock state snapshot
    -------------------
        {"type": "lock_state", "flow_id": <int>,
         "locks": {"<node_id>": {"member_id": "<str>", "user_id": <int>}}}
    """

    def __init__(self, registry: CollabSocketRegistry) -> None:
        self._registry = registry
        # flow_id → node_id → {"member_id": str, "user_id": int}
        self._locks: dict[int, dict[int, dict]] = {}

    def holder(self, flow_id: int, node_id: int) -> dict | None:
        """Return the current lock holder dict or None if the node is free."""
        return self._locks.get(flow_id, {}).get(node_id)

    def lock_state(self, flow_id: int) -> dict:
        """Return a serialisable snapshot of all locks for a flow.

        Return shape:
            {"<node_id>": {"member_id": "<str>", "user_id": <int>}}

        Keys are stringified node IDs to match the frozen wire format.
        """
        flow_locks = self._locks.get(flow_id, {})
        return {
            str(node_id): {"member_id": entry["member_id"], "user_id": entry["user_id"]}
            for node_id, entry in flow_locks.items()
        }

    async def acquire(
        self,
        flow_id: int,
        node_id: int,
        member_id: str,
        user_id: int,
        websocket: WebSocket,
    ) -> None:
        """Attempt to acquire the lock on ``node_id`` for ``member_id``.

        If the node is free or is already held by the SAME member (idempotent
        re-acquire), the lock is granted:
          - ``lock_granted`` is sent directly to ``websocket``.
          - ``node_locked`` is broadcast to ALL sockets on the flow.

        For an idempotent re-acquire the broadcast is still emitted so that
        late-joining peers receive the current lock state; the holder already
        knows it holds the lock, but the broadcast is harmless.

        If the node is held by a DIFFERENT member, ``lock_denied`` is sent
        only to ``websocket`` (no broadcast).
        """
        current = self.holder(flow_id, node_id)

        if current is not None and current["member_id"] != member_id:
            # Held by another member — deny, no broadcast.
            await websocket.send_json(
                {
                    "type": "lock_denied",
                    "flow_id": flow_id,
                    "node_id": node_id,
                    "holder_user_id": current["user_id"],
                }
            )
            logger.debug(
                "lock DENIED flow={} node={} requester={} holder={}",
                flow_id,
                node_id,
                member_id,
                current["member_id"],
            )
            return

        # Free or held by the same member — grant.
        if flow_id not in self._locks:
            self._locks[flow_id] = {}
        self._locks[flow_id][node_id] = {
            "member_id": member_id,
            "user_id": user_id,
        }

        await websocket.send_json(
            {"type": "lock_granted", "flow_id": flow_id, "node_id": node_id}
        )

        await self._registry.broadcast_json(
            flow_id,
            {
                "type": "node_locked",
                "flow_id": flow_id,
                "node_id": node_id,
                "origin": member_id,
                "user_id": user_id,
            },
        )

        logger.debug(
            "lock GRANTED flow={} node={} member={}",
            flow_id,
            node_id,
            member_id,
        )

    async def release(self, flow_id: int, node_id: int, member_id: str) -> None:
        """Release the lock on ``node_id``.

        Only the current holder may release.  A release attempt from a
        non-holder is silently ignored with a warning log — no broadcast,
        no error.

        On a valid release the lock entry is removed and ``node_unlocked``
        is broadcast to ALL sockets on the flow.
        """
        current = self.holder(flow_id, node_id)

        if current is None:
            logger.warning(
                "lock RELEASE ignored: node not locked flow={} node={} member={}",
                flow_id,
                node_id,
                member_id,
            )
            return

        if current["member_id"] != member_id:
            logger.warning(
                "lock RELEASE ignored: non-holder flow={} node={} "
                "requester={} holder={}",
                flow_id,
                node_id,
                member_id,
                current["member_id"],
            )
            return

        # Remove the lock entry.
        flow_locks = self._locks.get(flow_id)
        if flow_locks is not None:
            flow_locks.pop(node_id, None)
            if not flow_locks:
                del self._locks[flow_id]

        await self._registry.broadcast_json(
            flow_id,
            {
                "type": "node_unlocked",
                "flow_id": flow_id,
                "node_id": node_id,
                "origin": member_id,
            },
        )

        logger.debug(
            "lock RELEASED flow={} node={} member={}",
            flow_id,
            node_id,
            member_id,
        )

    async def release_all_for_member(self, flow_id: int, member_id: str) -> None:
        """Release every lock held by ``member_id`` on ``flow_id`` (EST-9).

        Called when the holder's connection drops (clean disconnect,
        heartbeat-sweep force-close, or registry on_drop).  Idempotent —
        a member holding no locks is a no-op, so the converging cleanup
        paths may all call this safely.

        Each released node is broadcast as ``node_unlocked`` with ``origin``
        set to the dropped holder's member_id (observers key their
        lockedByOther maps on origin) plus ``reason: "disconnected"``.
        """
        flow_locks = self._locks.get(flow_id)
        if not flow_locks:
            return

        released_node_ids = [
            node_id
            for node_id, entry in flow_locks.items()
            if entry["member_id"] == member_id
        ]
        if not released_node_ids:
            return

        # Mutate state BEFORE broadcasting: a broadcast may drop another dead
        # socket and re-enter this method via the registry's on_drop seam.
        for node_id in released_node_ids:
            del flow_locks[node_id]
        if not flow_locks:
            del self._locks[flow_id]

        for node_id in released_node_ids:
            await self._registry.broadcast_json(
                flow_id,
                {
                    "type": "node_unlocked",
                    "flow_id": flow_id,
                    "node_id": node_id,
                    "origin": member_id,
                    "reason": "disconnected",
                },
            )
            logger.info(
                "lock AUTO-RELEASED flow={} node={} member={} reason=disconnected",
                flow_id,
                node_id,
                member_id,
            )
