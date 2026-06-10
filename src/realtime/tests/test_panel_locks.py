"""Integration tests for exclusive node-panel locks (EST-8).

Covers:
  PL1  – lock_request → lock_granted to requester, node_locked broadcast to all
  PL2  – second requester → lock_denied with holder_user_id, no broadcast
  PL3  – release → node_unlocked broadcast; other member can then acquire
  PL4  – idempotent re-acquire by the same holder
  PL5  – non-holder release is silently ignored
  PL6  – lock_state snapshot sent to late joiner (locks present)
  PL7  – node_data_updated relayed when sender is the holder
  PL8  – node_data_updated dropped when sender is not the holder
  PL9  – flow isolation: locks on flow A don't affect flow B

All existing tests remain green.
"""

import json
from collections.abc import Callable
from types import SimpleNamespace

import fakeredis.aioredis as fake_aioredis
import pytest
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.testclient import TestClient
from pydantic import ValidationError

from application.collab_socket_registry import CollabSocketRegistry
from application.cursor_service import CursorService
from application.live_document_service import LiveDocumentService
from application.lock_service import LockService
from application.presence_service import PresenceService
from domain.models.collab_messages import (
    CursorMovedIn,
    LockReleaseIn,
    LockRequestIn,
    NodeDataUpdatedIn,
    NodeMovedIn,
    SelectionChangedIn,
)
from infrastructure.persistence.live_document_repository import LiveDocumentRepository
from infrastructure.persistence.presence_repository import PresenceRepository


# ---------------------------------------------------------------------------
# Harness helpers
# ---------------------------------------------------------------------------


def _make_fake_redis_client() -> fake_aioredis.FakeRedis:
    return fake_aioredis.FakeRedis(decode_responses=True)


def _make_services(
    fake_client: fake_aioredis.FakeRedis | None = None,
) -> tuple[
    PresenceService,
    LiveDocumentService,
    CursorService,
    LockService,
    CollabSocketRegistry,
]:
    """Build fully wired services backed by a shared in-process FakeRedis."""
    if fake_client is None:
        fake_client = _make_fake_redis_client()

    fake_redis_service = SimpleNamespace(aioredis_client=fake_client)

    presence_repo = PresenceRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    live_doc_repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    registry = CollabSocketRegistry()
    presence_svc = PresenceService(repository=presence_repo, registry=registry)
    live_doc_svc = LiveDocumentService(registry=registry, repository=live_doc_repo)
    cursor_svc = CursorService(registry=registry)
    lock_svc = LockService(registry=registry)

    return presence_svc, live_doc_svc, cursor_svc, lock_svc, registry


def _build_app(
    presence_service: PresenceService,
    live_document_service: LiveDocumentService,
    cursor_service: CursorService,
    lock_service: LockService,
    registry: CollabSocketRegistry,
    introspect_fn: Callable[[str], dict | None],
) -> FastAPI:
    """Minimal FastAPI app mirroring the production collab route with EST-8 changes."""
    app = FastAPI()

    @app.websocket("/realtime/collab/")
    async def collab(
        websocket: WebSocket,
        flow_id: int | None = None,
        token: str | None = None,
    ):
        if not token:
            await websocket.close(code=1008)
            return

        user_info = introspect_fn(token)
        if not user_info:
            await websocket.close(code=1008)
            return

        user_id = user_info.get("user_id")
        if not isinstance(user_id, int):
            await websocket.close(code=1008)
            return

        if flow_id is None:
            await websocket.close(code=1008)
            return

        await websocket.accept()
        member_id: str | None = None
        try:
            member_id = await presence_service.join(
                flow_id,
                websocket,
                user_id=user_id,
                display_name=user_info.get("display_name"),
            )

            # Document state snapshot.
            doc_state = await live_document_service.get_document_state(flow_id)
            await websocket.send_json(doc_state)

            # Self frame.
            await websocket.send_json(
                {
                    "type": "self",
                    "flow_id": flow_id,
                    "member_id": member_id,
                    "user_id": user_id,
                }
            )

            # Lock state snapshot — sent immediately after the self frame.
            await websocket.send_json(
                {
                    "type": "lock_state",
                    "flow_id": flow_id,
                    "locks": lock_service.lock_state(flow_id),
                }
            )

            while True:
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                    msg_type = data.get("type")
                    if msg_type == "node_moved":
                        frame = NodeMovedIn(**data)
                        await live_document_service.apply_node_move(
                            flow_id=frame.flow_id,
                            node_id=frame.node_id,
                            x=frame.x,
                            y=frame.y,
                            origin_member_id=member_id,
                        )
                    elif msg_type == "cursor_moved":
                        frame = CursorMovedIn(**data)
                        await cursor_service.relay_cursor(
                            flow_id=frame.flow_id,
                            x=frame.x,
                            y=frame.y,
                            origin_member_id=member_id,
                            user_id=user_id,
                        )
                    elif msg_type == "selection_changed":
                        frame = SelectionChangedIn(**data)
                        await cursor_service.relay_selection(
                            flow_id=frame.flow_id,
                            node_ids=frame.node_ids,
                            origin_member_id=member_id,
                            user_id=user_id,
                        )
                    elif msg_type == "lock_request":
                        frame = LockRequestIn(**data)
                        await lock_service.acquire(
                            flow_id=frame.flow_id,
                            node_id=frame.node_id,
                            member_id=member_id,
                            user_id=user_id,
                            websocket=websocket,
                        )
                    elif msg_type == "lock_release":
                        frame = LockReleaseIn(**data)
                        await lock_service.release(
                            flow_id=frame.flow_id,
                            node_id=frame.node_id,
                            member_id=member_id,
                        )
                    elif msg_type == "node_data_updated":
                        frame = NodeDataUpdatedIn(**data)
                        current_holder = lock_service.holder(
                            frame.flow_id, frame.node_id
                        )
                        if (
                            current_holder is not None
                            and current_holder["member_id"] == member_id
                        ):
                            await registry.broadcast_json(
                                frame.flow_id,
                                {
                                    "type": "node_data_updated",
                                    "flow_id": frame.flow_id,
                                    "node_id": frame.node_id,
                                    "node_name": frame.node_name,
                                    "data": frame.data,
                                    "origin": member_id,
                                },
                            )
                        # else: silently drop — non-holder update
                    # unknown type → silently ignore
                except (json.JSONDecodeError, ValidationError):
                    pass  # malformed → ignore, do not close
        except WebSocketDisconnect:
            pass
        finally:
            if member_id is not None:
                await presence_service.leave(flow_id, websocket, member_id)

    return app


def _valid_user(
    user_id: int = 1, display_name: str = "Tester"
) -> Callable[[str], dict | None]:
    def introspect(token: str) -> dict | None:
        return {"active": True, "user_id": user_id, "display_name": display_name}

    return introspect


def _drain_join(ws) -> str:
    """Consume the 4 join-time frames and return the member_id from the self frame."""
    ws.receive_text()  # presence
    ws.receive_text()  # document_state
    self_msg = json.loads(ws.receive_text())  # self
    ws.receive_text()  # lock_state
    return self_msg["member_id"]


# ---------------------------------------------------------------------------
# PL1 – lock_request → lock_granted + node_locked broadcast
# ---------------------------------------------------------------------------


class TestLockGrant:
    """A free node may be locked; requester gets lock_granted; all see node_locked."""

    def test_lock_request_grants_and_broadcasts(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=10),
        )

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=1&token=t"
            ) as ws_a:
                member_id_a = _drain_join(ws_a)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=1&token=t"
                ) as ws_b:
                    # ws_b join — drain ws_b and the presence update on ws_a.
                    _drain_join(ws_b)
                    ws_a.receive_text()  # presence update (count=2)

                    # ws_a requests the lock.
                    ws_a.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 1, "node_id": 42}
                        )
                    )

                    # ws_a must receive lock_granted (direct).
                    granted = json.loads(ws_a.receive_text())
                    assert granted == {
                        "type": "lock_granted",
                        "flow_id": 1,
                        "node_id": 42,
                    }

                    # Both ws_a and ws_b must receive the node_locked broadcast.
                    locked_a = json.loads(ws_a.receive_text())
                    locked_b = json.loads(ws_b.receive_text())

                    for msg in (locked_a, locked_b):
                        assert msg["type"] == "node_locked"
                        assert msg["flow_id"] == 1
                        assert msg["node_id"] == 42
                        assert msg["origin"] == member_id_a
                        assert msg["user_id"] == 10


# ---------------------------------------------------------------------------
# PL2 – second requester → lock_denied with holder_user_id, no broadcast
# ---------------------------------------------------------------------------


class TestLockDeny:
    """When a node is held, a different member gets lock_denied only."""

    def test_lock_denied_carries_holder_user_id_and_no_broadcast(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()

        # Build an app that maps different tokens to different identities.
        app = FastAPI()
        users = {
            "token-alice": {"active": True, "user_id": 10, "display_name": "Alice"},
            "token-bob": {"active": True, "user_id": 20, "display_name": "Bob"},
        }

        @app.websocket("/realtime/collab/")
        async def collab(
            websocket: WebSocket,
            flow_id: int | None = None,
            token: str | None = None,
        ):
            if not token or token not in users:
                await websocket.close(code=1008)
                return
            if flow_id is None:
                await websocket.close(code=1008)
                return
            await websocket.accept()
            user_info = users[token]
            user_id = user_info["user_id"]
            member_id: str | None = None
            try:
                member_id = await presence_svc.join(flow_id, websocket, user_id=user_id)
                await websocket.send_json(
                    await live_doc_svc.get_document_state(flow_id)
                )
                await websocket.send_json(
                    {
                        "type": "self",
                        "flow_id": flow_id,
                        "member_id": member_id,
                        "user_id": user_id,
                    }
                )
                await websocket.send_json(
                    {
                        "type": "lock_state",
                        "flow_id": flow_id,
                        "locks": lock_svc.lock_state(flow_id),
                    }
                )
                while True:
                    raw = await websocket.receive_text()
                    try:
                        data = json.loads(raw)
                        if data.get("type") == "lock_request":
                            frame = LockRequestIn(**data)
                            await lock_svc.acquire(
                                flow_id=frame.flow_id,
                                node_id=frame.node_id,
                                member_id=member_id,
                                user_id=user_id,
                                websocket=websocket,
                            )
                    except (json.JSONDecodeError, ValidationError):
                        pass
            except WebSocketDisconnect:
                pass
            finally:
                if member_id is not None:
                    await presence_svc.leave(flow_id, websocket, member_id)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=2&token=token-alice"
            ) as ws_alice:
                ws_alice.receive_text()  # presence
                ws_alice.receive_text()  # doc_state
                self_alice = json.loads(ws_alice.receive_text())
                ws_alice.receive_text()  # lock_state
                member_id_alice = self_alice["member_id"]

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=2&token=token-bob"
                ) as ws_bob:
                    ws_bob.receive_text()  # presence
                    ws_bob.receive_text()  # doc_state
                    ws_bob.receive_text()  # self
                    ws_bob.receive_text()  # lock_state
                    ws_alice.receive_text()  # presence update (count=2)

                    # Alice acquires the lock first.
                    ws_alice.send_text(
                        json.dumps({"type": "lock_request", "flow_id": 2, "node_id": 7})
                    )
                    ws_alice.receive_text()  # lock_granted to Alice
                    ws_alice.receive_text()  # node_locked broadcast (Alice)
                    ws_bob.receive_text()  # node_locked broadcast (Bob)

                    # Bob now tries to acquire the same node.
                    ws_bob.send_text(
                        json.dumps({"type": "lock_request", "flow_id": 2, "node_id": 7})
                    )

                    # Bob receives lock_denied with Alice's user_id.
                    denied = json.loads(ws_bob.receive_text())
                    assert denied["type"] == "lock_denied"
                    assert denied["flow_id"] == 2
                    assert denied["node_id"] == 7
                    assert denied["holder_user_id"] == 10  # Alice's user_id

                    # Alice must NOT receive any additional message (no broadcast).
                    # Send a ping from Alice and confirm it echoes back cleanly —
                    # if Alice had an extra message buffered this would shift the order.
                    ws_alice.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 2, "node_id": 999}
                        )
                    )
                    # 999 is free — Alice gets granted + broadcast
                    next_alice = json.loads(ws_alice.receive_text())
                    assert next_alice["type"] == "lock_granted"
                    assert next_alice["node_id"] == 999


# ---------------------------------------------------------------------------
# PL3 – release → node_unlocked; another member can then acquire
# ---------------------------------------------------------------------------


class TestLockRelease:
    """After the holder releases, another member can acquire the same node."""

    def test_release_broadcasts_node_unlocked_and_frees_node(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=5),
        )

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=3&token=t"
            ) as ws_a:
                member_id_a = _drain_join(ws_a)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=3&token=t"
                ) as ws_b:
                    _drain_join(ws_b)
                    ws_a.receive_text()  # presence update

                    # ws_a acquires node 10.
                    ws_a.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 3, "node_id": 10}
                        )
                    )
                    ws_a.receive_text()  # lock_granted
                    ws_a.receive_text()  # node_locked (broadcast to ws_a)
                    ws_b.receive_text()  # node_locked (broadcast to ws_b)

                    # ws_a releases.
                    ws_a.send_text(
                        json.dumps(
                            {"type": "lock_release", "flow_id": 3, "node_id": 10}
                        )
                    )

                    # Both receive node_unlocked broadcast.
                    unlocked_a = json.loads(ws_a.receive_text())
                    unlocked_b = json.loads(ws_b.receive_text())

                    for msg in (unlocked_a, unlocked_b):
                        assert msg["type"] == "node_unlocked"
                        assert msg["flow_id"] == 3
                        assert msg["node_id"] == 10
                        assert msg["origin"] == member_id_a

                    # ws_b can now acquire node 10.
                    ws_b.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 3, "node_id": 10}
                        )
                    )
                    granted_b = json.loads(ws_b.receive_text())
                    assert granted_b["type"] == "lock_granted"
                    assert granted_b["node_id"] == 10


# ---------------------------------------------------------------------------
# PL4 – idempotent re-acquire by the same holder
# ---------------------------------------------------------------------------


class TestIdempotentReAcquire:
    """The holder may re-acquire its own lock without error."""

    def test_holder_reacquire_grants_again_and_broadcasts(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=3),
        )

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=4&token=t") as ws:
                member_id = _drain_join(ws)

                # First acquire.
                ws.send_text(
                    json.dumps({"type": "lock_request", "flow_id": 4, "node_id": 1})
                )
                granted1 = json.loads(ws.receive_text())
                assert granted1["type"] == "lock_granted"
                ws.receive_text()  # node_locked broadcast

                # Re-acquire by the same member — must grant again.
                ws.send_text(
                    json.dumps({"type": "lock_request", "flow_id": 4, "node_id": 1})
                )
                granted2 = json.loads(ws.receive_text())
                assert granted2["type"] == "lock_granted"
                assert granted2["node_id"] == 1

                # Broadcast must follow.
                locked2 = json.loads(ws.receive_text())
                assert locked2["type"] == "node_locked"
                assert locked2["origin"] == member_id


# ---------------------------------------------------------------------------
# PL5 – non-holder release is silently ignored
# ---------------------------------------------------------------------------


class TestNonHolderRelease:
    """A release from a member that does not hold the lock must be ignored."""

    def test_non_holder_release_is_ignored(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=9),
        )

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=5&token=t"
            ) as ws_a:
                _drain_join(ws_a)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=5&token=t"
                ) as ws_b:
                    _drain_join(ws_b)
                    ws_a.receive_text()  # presence update

                    # ws_a acquires node 5.
                    ws_a.send_text(
                        json.dumps({"type": "lock_request", "flow_id": 5, "node_id": 5})
                    )
                    ws_a.receive_text()  # lock_granted
                    ws_a.receive_text()  # node_locked (ws_a)
                    ws_b.receive_text()  # node_locked (ws_b)

                    # ws_b (non-holder) sends a release — must be silently ignored.
                    ws_b.send_text(
                        json.dumps({"type": "lock_release", "flow_id": 5, "node_id": 5})
                    )

                    # Confirm ws_b is still alive and ws_a did not get any message.
                    # Send a valid lock_request from ws_b for a NEW node — both should
                    # get granted + broadcast without any intervening frames.
                    ws_b.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 5, "node_id": 999}
                        )
                    )
                    next_b = json.loads(ws_b.receive_text())
                    assert next_b["type"] == "lock_granted"
                    assert next_b["node_id"] == 999

                    # ws_a must receive the broadcast for node 999 as the next message —
                    # no spurious node_unlocked for node 5 should appear first.
                    next_a = json.loads(ws_a.receive_text())
                    assert next_a["type"] == "node_locked"
                    assert next_a["node_id"] == 999


# ---------------------------------------------------------------------------
# PL6 – lock_state snapshot for late joiner
# ---------------------------------------------------------------------------


class TestLockStateSnapshot:
    """A client that joins after locks have been acquired receives a lock_state."""

    def test_late_joiner_receives_lock_state_with_active_locks(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=4),
        )

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=6&token=t"
            ) as ws_early:
                member_id_early = _drain_join(ws_early)

                # ws_early acquires a lock.
                ws_early.send_text(
                    json.dumps({"type": "lock_request", "flow_id": 6, "node_id": 77})
                )
                ws_early.receive_text()  # lock_granted
                ws_early.receive_text()  # node_locked (only ws_early in flow)

                # Now a late joiner connects.
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=6&token=t"
                ) as ws_late:
                    ws_late.receive_text()  # presence broadcast
                    ws_late.receive_text()  # document_state
                    self_late = json.loads(ws_late.receive_text())  # self
                    lock_state_msg = json.loads(ws_late.receive_text())  # lock_state

                    assert lock_state_msg["type"] == "lock_state"
                    assert lock_state_msg["flow_id"] == 6
                    locks = lock_state_msg["locks"]
                    assert "77" in locks
                    assert locks["77"]["member_id"] == member_id_early
                    assert locks["77"]["user_id"] == 4

    def test_late_joiner_receives_empty_lock_state_when_no_locks(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=1),
        )

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=7&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # doc_state
                ws.receive_text()  # self
                lock_state_msg = json.loads(ws.receive_text())

                assert lock_state_msg["type"] == "lock_state"
                assert lock_state_msg["flow_id"] == 7
                assert lock_state_msg["locks"] == {}


# ---------------------------------------------------------------------------
# PL7 – node_data_updated relayed when sender is the holder
# ---------------------------------------------------------------------------


class TestNodeDataUpdatedRelay:
    """node_data_updated from the lock holder is broadcast to all sockets on the flow."""

    def test_data_update_from_holder_reaches_all(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=11),
        )

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=8&token=t"
            ) as ws_a:
                member_id_a = _drain_join(ws_a)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=8&token=t"
                ) as ws_b:
                    _drain_join(ws_b)
                    ws_a.receive_text()  # presence update

                    # ws_a acquires the lock.
                    ws_a.send_text(
                        json.dumps({"type": "lock_request", "flow_id": 8, "node_id": 3})
                    )
                    ws_a.receive_text()  # lock_granted
                    ws_a.receive_text()  # node_locked (ws_a)
                    ws_b.receive_text()  # node_locked (ws_b)

                    # ws_a (holder) sends node_data_updated.
                    ws_a.send_text(
                        json.dumps(
                            {
                                "type": "node_data_updated",
                                "flow_id": 8,
                                "node_id": 3,
                                "node_name": "MyNode",
                                "data": {"key": "value", "count": 42},
                            }
                        )
                    )

                    # Both ws_a and ws_b must receive the broadcast.
                    msg_a = json.loads(ws_a.receive_text())
                    msg_b = json.loads(ws_b.receive_text())

                    for msg in (msg_a, msg_b):
                        assert msg["type"] == "node_data_updated"
                        assert msg["flow_id"] == 8
                        assert msg["node_id"] == 3
                        assert msg["node_name"] == "MyNode"
                        assert msg["data"] == {"key": "value", "count": 42}
                        assert msg["origin"] == member_id_a


# ---------------------------------------------------------------------------
# PL8 – node_data_updated dropped when sender is not the holder
# ---------------------------------------------------------------------------


class TestNodeDataUpdatedDropped:
    """node_data_updated from a non-holder is silently dropped."""

    def test_data_update_from_non_holder_is_dropped(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=12),
        )

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=9&token=t"
            ) as ws_a:
                _drain_join(ws_a)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=9&token=t"
                ) as ws_b:
                    _drain_join(ws_b)
                    ws_a.receive_text()  # presence update

                    # ws_a acquires the lock.
                    ws_a.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 9, "node_id": 20}
                        )
                    )
                    ws_a.receive_text()  # lock_granted
                    ws_a.receive_text()  # node_locked (ws_a)
                    ws_b.receive_text()  # node_locked (ws_b)

                    # ws_b (non-holder) sends node_data_updated — must be dropped.
                    ws_b.send_text(
                        json.dumps(
                            {
                                "type": "node_data_updated",
                                "flow_id": 9,
                                "node_id": 20,
                                "node_name": "SomeNode",
                                "data": {"bad": "actor"},
                            }
                        )
                    )

                    # Neither ws_a nor ws_b should have received any message.
                    # Verify by sending a ping (lock_request on a free node) from ws_b
                    # and confirming the very next messages are grant+broadcast only.
                    ws_b.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 9, "node_id": 888}
                        )
                    )
                    next_b = json.loads(ws_b.receive_text())
                    assert next_b["type"] == "lock_granted"
                    assert next_b["node_id"] == 888

                    next_a = json.loads(ws_a.receive_text())
                    assert next_a["type"] == "node_locked"
                    assert next_a["node_id"] == 888

    def test_data_update_for_unlocked_node_is_dropped(self):
        """node_data_updated for a node with no lock is also dropped."""
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=1),
        )

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=10&token=t") as ws:
                _drain_join(ws)

                # Send node_data_updated without holding any lock.
                ws.send_text(
                    json.dumps(
                        {
                            "type": "node_data_updated",
                            "flow_id": 10,
                            "node_id": 55,
                            "node_name": "FreeNode",
                            "data": {},
                        }
                    )
                )

                # No message should arrive — confirm socket is still alive with a lock request.
                ws.send_text(
                    json.dumps({"type": "lock_request", "flow_id": 10, "node_id": 55})
                )
                granted = json.loads(ws.receive_text())
                assert granted["type"] == "lock_granted"


# ---------------------------------------------------------------------------
# PL9 – flow isolation
# ---------------------------------------------------------------------------


class TestFlowIsolation:
    """Locks on flow A must not affect flow B."""

    def test_lock_on_flow_a_not_visible_in_flow_b(self):
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry = _make_services()
        app = _build_app(
            presence_svc,
            live_doc_svc,
            cursor_svc,
            lock_svc,
            registry,
            _valid_user(user_id=1),
        )

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=100&token=t"
            ) as ws_100:
                _drain_join(ws_100)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=200&token=t"
                ) as ws_200:
                    _drain_join(ws_200)

                    # ws_100 acquires node 5 on flow 100.
                    ws_100.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 100, "node_id": 5}
                        )
                    )
                    ws_100.receive_text()  # lock_granted
                    ws_100.receive_text()  # node_locked (only socket on flow 100)

                    # ws_200 must NOT have received the lock event.
                    # Verify by having ws_200 request node 5 on flow 200 — should be granted.
                    ws_200.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 200, "node_id": 5}
                        )
                    )
                    granted_200 = json.loads(ws_200.receive_text())
                    assert granted_200["type"] == "lock_granted"
                    assert granted_200["flow_id"] == 200
                    assert granted_200["node_id"] == 5

                    # lock_state on flow 200 only knows about its own locks.
                    assert lock_svc.lock_state(100) != {}
                    state_200 = lock_svc.lock_state(200)
                    assert "5" in state_200
                    # State for flow 100 only has flow 100's node — confirming isolation.
                    state_100 = lock_svc.lock_state(100)
                    assert "5" in state_100
