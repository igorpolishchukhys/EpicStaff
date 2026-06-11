"""Tests for FlushCoordinator and the EST-7 flush-trigger behaviour.

Covers:
  FC1 – periodic tick sends flush_requested(reason="periodic") to the
        designated socket ONLY; non-designated sockets get nothing.
  FC2 – PresenceService: A joins then B joins → designated_member_id == A.
  FC3 – A leaves → designation moves to B and the next presence broadcast
        carries B's member_id in designated_member_id.
  FC4 – room-empty: last leave → count==0 → clear_flow called and all four
        collab:flow:{id}:* keys are gone, and the per-flow timer is cancelled.
  FC5 – periodic tick does NOT clear Redis (keys still present after a tick
        while a client is connected).
"""

import asyncio
import json
from types import SimpleNamespace

import fakeredis.aioredis as fake_aioredis
import pytest

from application.collab_socket_registry import CollabSocketRegistry
from application.flush_coordinator import FlushCoordinator
from application.presence_service import PresenceService
from infrastructure.persistence.live_document_repository import LiveDocumentRepository
from infrastructure.persistence.presence_repository import PresenceRepository


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_fake_redis():
    """Return a (fake_redis_service, fake_client) pair."""
    fake_client = fake_aioredis.FakeRedis(decode_responses=True)
    fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
    return fake_redis_service, fake_client


def _make_services(fake_redis_service=None):
    """Wire up all collab services backed by FakeRedis.

    Returns (presence_svc, registry, live_doc_repo, fake_client).
    """
    if fake_redis_service is None:
        fake_redis_service, fake_client = _make_fake_redis()
    else:
        fake_client = fake_redis_service.aioredis_client

    registry = CollabSocketRegistry()
    presence_repo = PresenceRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    live_doc_repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    presence_svc = PresenceService(repository=presence_repo, registry=registry)

    flush_coord = FlushCoordinator(
        presence_service=presence_svc,
        registry=registry,
        live_document_repository=live_doc_repo,
        interval=9999,  # never fires on its own during tests
    )
    presence_svc.set_flush_coordinator(flush_coord)

    return presence_svc, registry, live_doc_repo, fake_client, flush_coord


class _FakeSocket:
    """Minimal async WebSocket stub that captures sent messages."""

    def __init__(self, alive: bool = True) -> None:
        self.sent: list[dict] = []
        self._alive = alive

    async def send_text(self, message: str) -> None:
        if not self._alive:
            raise RuntimeError("socket is dead")
        self.sent.append(json.loads(message))

    def kill(self) -> None:
        self._alive = False


# ---------------------------------------------------------------------------
# FC1 – tick sends to designated socket ONLY
# ---------------------------------------------------------------------------


class TestTickSendsToDesignatedOnly:
    """flush_requested goes to the designated (oldest-joined) socket only."""

    @pytest.mark.asyncio
    async def test_tick_sends_only_to_designated(self):
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        socket_b = _FakeSocket()

        # A joins first (becomes designated), then B.
        member_a = await presence_svc.join(1, socket_a, user_id=10)
        member_b = await presence_svc.join(1, socket_b, user_id=20)

        # Clear sent buffers (presence broadcasts from join).
        socket_a.sent.clear()
        socket_b.sent.clear()

        # Fire one tick manually.
        await flush_coord._tick(1)

        # Only socket_a (designated) gets flush_requested.
        assert len(socket_a.sent) == 1
        assert socket_a.sent[0] == {
            "type": "flush_requested",
            "flow_id": 1,
            "reason": "periodic",
        }
        # Non-designated socket_b gets nothing.
        assert socket_b.sent == []

    @pytest.mark.asyncio
    async def test_tick_with_no_designated_socket_is_noop(self):
        """If no sockets are connected, tick is a silent no-op."""
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )
        # Nobody joined — should not raise.
        await flush_coord._tick(99)


# ---------------------------------------------------------------------------
# FC2 – join order: A then B → designated is A
# ---------------------------------------------------------------------------


class TestDesignationJoinOrder:
    """First joiner is always the designated member."""

    @pytest.mark.asyncio
    async def test_first_joiner_is_designated(self):
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        socket_b = _FakeSocket()

        member_a = await presence_svc.join(2, socket_a, user_id=1)
        member_b = await presence_svc.join(2, socket_b, user_id=2)

        assert presence_svc.designated_member_id(2) == member_a
        assert presence_svc.designated_socket(2) is socket_a

    @pytest.mark.asyncio
    async def test_presence_broadcast_carries_designated_member_id(self):
        """The presence broadcast includes designated_member_id == A's member_id."""
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        socket_b = _FakeSocket()

        member_a = await presence_svc.join(3, socket_a, user_id=10)
        # Capture the presence broadcast sent when A joined.
        presence_on_a_join = socket_a.sent[-1]
        assert presence_on_a_join["type"] == "presence"
        assert presence_on_a_join["designated_member_id"] == member_a

        member_b = await presence_svc.join(3, socket_b, user_id=20)
        # After B joins the broadcast is re-sent; designated is still A.
        presence_after_b_join = socket_a.sent[-1]
        assert presence_after_b_join["designated_member_id"] == member_a


# ---------------------------------------------------------------------------
# FC3 – A leaves → designation moves to B; presence broadcast updated
# ---------------------------------------------------------------------------


class TestDesignationMovesOnLeave:
    """When the designated member leaves, the next-oldest member is promoted."""

    @pytest.mark.asyncio
    async def test_designation_moves_to_b_after_a_leaves(self):
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        socket_b = _FakeSocket()

        member_a = await presence_svc.join(4, socket_a, user_id=1)
        member_b = await presence_svc.join(4, socket_b, user_id=2)

        assert presence_svc.designated_member_id(4) == member_a

        socket_b.sent.clear()

        # A leaves.
        await presence_svc.leave(4, socket_a, member_a)

        # After A leaves, B is the designated member.
        assert presence_svc.designated_member_id(4) == member_b
        assert presence_svc.designated_socket(4) is socket_b

        # The leave broadcast sent to B must carry B's member_id as designated.
        leave_broadcast = socket_b.sent[-1]
        assert leave_broadcast["type"] == "presence"
        assert leave_broadcast["designated_member_id"] == member_b

    @pytest.mark.asyncio
    async def test_tick_targets_new_designated_after_a_leaves(self):
        """After A leaves, a tick must go to B (the new designated)."""
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        socket_b = _FakeSocket()

        member_a = await presence_svc.join(5, socket_a, user_id=1)
        member_b = await presence_svc.join(5, socket_b, user_id=2)

        await presence_svc.leave(5, socket_a, member_a)

        socket_b.sent.clear()

        await flush_coord._tick(5)

        assert len(socket_b.sent) == 1
        assert socket_b.sent[0]["type"] == "flush_requested"


# ---------------------------------------------------------------------------
# FC4 – room-empty: clear_flow called, keys gone, timer cancelled
# ---------------------------------------------------------------------------


class TestRoomEmptyGC:
    """Last leave triggers GC and cancels the per-flow timer."""

    @pytest.mark.asyncio
    async def test_last_leave_clears_redis_keys(self):
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()

        member_a = await presence_svc.join(6, socket_a, user_id=1)

        # Seed all four collab keys so we can verify they are deleted.
        await live_doc_repo.set_position(6, 1, 10.0, 20.0)
        await live_doc_repo.add_node(6, "node-key-1", {"type": "agent"})
        await live_doc_repo.add_connection(
            6, "conn-1", "node-key-1", "node-key-2", "p1", "p2", {}
        )
        await live_doc_repo.add_node_tombstone(6, "deleted-node")

        # Verify keys exist before leave.
        assert await fake_client.exists(f"collab:flow:6:positions") == 1
        assert await fake_client.exists(f"collab:flow:6:nodes") == 1
        assert await fake_client.exists(f"collab:flow:6:connections") == 1
        assert await fake_client.exists(f"collab:flow:6:tombstones") == 1

        # Last member leaves → on_room_empty → clear_flow.
        await presence_svc.leave(6, socket_a, member_a)

        assert await fake_client.exists(f"collab:flow:6:positions") == 0
        assert await fake_client.exists(f"collab:flow:6:nodes") == 0
        assert await fake_client.exists(f"collab:flow:6:connections") == 0
        assert await fake_client.exists(f"collab:flow:6:tombstones") == 0

    @pytest.mark.asyncio
    async def test_last_leave_cancels_timer_task(self):
        """The per-flow asyncio task is cancelled when the room empties."""
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        member_a = await presence_svc.join(7, socket_a, user_id=1)

        # A task should have been started by on_room_active.
        assert 7 in flush_coord._tasks
        task = flush_coord._tasks[7]
        assert not task.done()

        await presence_svc.leave(7, socket_a, member_a)

        # Task removed and cancelled.
        assert 7 not in flush_coord._tasks
        # Give the event loop a chance to process the cancellation.
        await asyncio.sleep(0)
        assert task.cancelled()

    @pytest.mark.asyncio
    async def test_two_members_last_leave_triggers_gc(self):
        """GC only fires when count reaches 0 — not on any leave."""
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        socket_b = _FakeSocket()

        member_a = await presence_svc.join(8, socket_a, user_id=1)
        member_b = await presence_svc.join(8, socket_b, user_id=2)

        # Seed a key.
        await live_doc_repo.set_position(8, 1, 5.0, 5.0)
        assert await fake_client.exists("collab:flow:8:positions") == 1

        # First leave — room is NOT empty; key must still exist.
        await presence_svc.leave(8, socket_a, member_a)
        assert await fake_client.exists("collab:flow:8:positions") == 1

        # Second (last) leave — now GC fires.
        await presence_svc.leave(8, socket_b, member_b)
        assert await fake_client.exists("collab:flow:8:positions") == 0


# ---------------------------------------------------------------------------
# FC6 – on_room_empty race: concurrent join prevents GC
# ---------------------------------------------------------------------------


class TestOnRoomEmptyRaceGuard:
    """on_room_empty must not GC when a concurrent join has already incremented
    the count back above 0 (client B joins before on_room_empty fires)."""

    @pytest.mark.asyncio
    async def test_concurrent_join_prevents_gc_and_keeps_timer(self):
        """Simulate the race: A leaves (count→0 in PresenceService.leave),
        then B joins (count→1 in Redis), then on_room_empty fires.

        Expected outcome:
        - clear_flow is NOT called (live document keys survive).
        - The timer task started by B's join is still alive (not cancelled).
        """
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        socket_b = _FakeSocket()

        # A joins the room (starts the timer).
        member_a = await presence_svc.join(10, socket_a, user_id=1)

        # Seed a live document key so we can verify it survives.
        await live_doc_repo.set_position(10, 1, 1.0, 2.0)
        assert await fake_client.exists("collab:flow:10:positions") == 1

        # Manually replicate the race:
        #   1. Remove A from Redis (as leave() would do before calling on_room_empty).
        await presence_svc._repository.remove_member(10, member_a)
        #   2. B joins — increments Redis count back to 1.
        member_b = await presence_svc.join(10, socket_b, user_id=2)
        task_b = flush_coord._tasks.get(10)
        assert (
            task_b is not None and not task_b.done()
        ), "B's join must have started (or kept) the timer task"

        #   3. Now on_room_empty fires (as the leave() coroutine would call it).
        await flush_coord.on_room_empty(10)

        # GC must NOT have run — the key must still exist.
        assert (
            await fake_client.exists("collab:flow:10:positions") == 1
        ), "clear_flow must not be called when count > 0"

        # The timer task must still be alive.
        assert 10 in flush_coord._tasks, "timer task must survive the skipped GC"
        assert not flush_coord._tasks[10].done(), "timer task must still be running"

        # Verify it is the same task started for B (not a new one).
        assert flush_coord._tasks[10] is task_b


# ---------------------------------------------------------------------------
# FC5 – periodic tick does NOT clear Redis
# ---------------------------------------------------------------------------


class TestTickDoesNotClearRedis:
    """A flush tick must never delete the live document from Redis."""

    @pytest.mark.asyncio
    async def test_tick_leaves_redis_keys_intact(self):
        presence_svc, registry, live_doc_repo, fake_client, flush_coord = (
            _make_services()
        )

        socket_a = _FakeSocket()
        member_a = await presence_svc.join(9, socket_a, user_id=1)

        # Seed data.
        await live_doc_repo.set_position(9, 1, 1.0, 2.0)
        await live_doc_repo.add_node(9, "nk", {"x": 0})

        # Fire a tick.
        await flush_coord._tick(9)

        # Both keys must still exist.
        assert await fake_client.exists("collab:flow:9:positions") == 1
        assert await fake_client.exists("collab:flow:9:nodes") == 1

        # flush_requested was sent to the only (designated) socket.
        assert any(m.get("type") == "flush_requested" for m in socket_a.sent)
