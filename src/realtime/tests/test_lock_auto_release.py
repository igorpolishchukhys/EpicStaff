"""Integration tests for lock auto-release on disconnect (EST-9).

Covers:
  AR1 – holder clean disconnect → node_unlocked broadcast with the holder's
        member_id as origin and reason "disconnected"; node lockable again
        (also: a holder of MULTIPLE nodes gets one node_unlocked per node)
  AR2 – heartbeat timeout: fake clock past 30s, sweep_once() force-closes the
        zombie socket; the endpoint finally path releases + broadcasts
  AR3 – ANY inbound frame refreshes liveness — sweep does not expire it
  AR4 – heartbeat frame → sender receives heartbeat_ack (direct, no broadcast)
  AR5 – reconnect after release: lock_state snapshot has no stale lock
  AR6 – member with no locks disconnecting is a no-op (no node_unlocked)
  AR7 – registry on_drop is multiplexed: all callbacks fire per dropped socket
  AR8 – belt-and-braces: socket dropped mid-broadcast → presence purged AND
        the dropped holder's lock auto-released (regression for the seam)

TestClient notes:

* Starlette's TestClient does not emulate the transport layer, so a
  server-side ``websocket.close()`` (AR2) is delivered to the test client but
  does NOT wake the endpoint's pending receive by itself — in production
  uvicorn follows the close with a ``websocket.disconnect``.  Tests deliver
  that disconnect explicitly via ``ws.close(1000)``.
* Disconnects are delivered via an explicit ``ws.close(1000)`` while the
  session context stays open, NOT by exiting the ``with`` block: the session's
  ``__exit__`` cancels the app task's scope right after sending the
  disconnect, which can abort the endpoint's ``finally`` mid-broadcast (a
  TestClient teardown artifact — in production nothing cancels the endpoint).
  The peer's blocking receive is then the synchronization point.
"""

import asyncio
import json
from collections.abc import Callable

import fakeredis.aioredis as fake_aioredis
import pytest
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.testclient import TestClient
from pydantic import ValidationError
from types import SimpleNamespace

from application.collab_socket_registry import CollabSocketRegistry
from application.cursor_service import CursorService
from application.heartbeat_monitor import (
    LIVENESS_TIMEOUT_SECONDS,
    HeartbeatMonitor,
)
from application.live_document_service import LiveDocumentService
from application.lock_service import LockService
from application.presence_service import PresenceService
from domain.models.collab_messages import (
    CursorMovedIn,
    HeartbeatIn,
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


class FakeClock:
    """Injectable monotonic clock so tests control sweep timing."""

    def __init__(self) -> None:
        self.now = 0.0

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def __call__(self) -> float:
        return self.now


def _wire_lock_release_on_drop(
    registry: CollabSocketRegistry,
    monitor: HeartbeatMonitor,
    lock_service: LockService,
) -> None:
    """Mirror of the production on_drop hook in api/main.py."""

    def _release_locks_for_dropped_socket(websocket: WebSocket) -> None:
        tracked = monitor.lookup(websocket)
        monitor.forget(websocket)
        if tracked is None:
            return
        dropped_flow_id, dropped_member_id = tracked
        asyncio.create_task(
            lock_service.release_all_for_member(dropped_flow_id, dropped_member_id)
        )

    registry.add_on_drop(_release_locks_for_dropped_socket)


def _make_services(
    clock: Callable[[], float] | None = None,
) -> tuple[
    PresenceService,
    LiveDocumentService,
    CursorService,
    LockService,
    CollabSocketRegistry,
    HeartbeatMonitor,
]:
    """Build fully wired services backed by a shared in-process FakeRedis."""
    fake_client = fake_aioredis.FakeRedis(decode_responses=True)
    fake_redis_service = SimpleNamespace(aioredis_client=fake_client)

    presence_repo = PresenceRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    live_doc_repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    registry = CollabSocketRegistry()
    presence_svc = PresenceService(repository=presence_repo, registry=registry)
    live_doc_svc = LiveDocumentService(registry=registry, repository=live_doc_repo)
    cursor_svc = CursorService(registry=registry)
    lock_svc = LockService(registry=registry)
    monitor = HeartbeatMonitor(clock=clock) if clock is not None else HeartbeatMonitor()
    _wire_lock_release_on_drop(registry, monitor, lock_svc)

    return presence_svc, live_doc_svc, cursor_svc, lock_svc, registry, monitor


def _build_app(
    presence_service: PresenceService,
    live_document_service: LiveDocumentService,
    cursor_service: CursorService,
    lock_service: LockService,
    registry: CollabSocketRegistry,
    monitor: HeartbeatMonitor,
    introspect_fn: Callable[[str], dict | None],
) -> FastAPI:
    """Minimal FastAPI app mirroring the production collab route with EST-9 changes."""
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

            monitor.track(websocket, flow_id, member_id)

            doc_state = await live_document_service.get_document_state(flow_id)
            await websocket.send_json(doc_state)

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
                    "locks": lock_service.lock_state(flow_id),
                }
            )

            while True:
                raw = await websocket.receive_text()
                monitor.touch(websocket)
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
                    elif msg_type == "heartbeat":
                        frame = HeartbeatIn(**data)
                        await websocket.send_json(
                            {"type": "heartbeat_ack", "flow_id": frame.flow_id}
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
                    # unknown type → silently ignore
                except (json.JSONDecodeError, ValidationError):
                    pass  # malformed → ignore, do not close
        except WebSocketDisconnect:
            pass
        finally:
            monitor.forget(websocket)
            if member_id is not None:
                await lock_service.release_all_for_member(flow_id, member_id)
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


def _drain_join_capture_lock_state(ws) -> tuple[str, dict]:
    """Like _drain_join but also returns the lock_state frame."""
    ws.receive_text()  # presence
    ws.receive_text()  # document_state
    self_msg = json.loads(ws.receive_text())  # self
    lock_state_msg = json.loads(ws.receive_text())  # lock_state
    return self_msg["member_id"], lock_state_msg


class _ScriptedSocket:
    """Fake websocket for direct service-level tests; can be flipped dead."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.dead = False

    async def send_text(self, message: str) -> None:
        if self.dead:
            raise RuntimeError("dead socket")
        self.sent.append(json.loads(message))

    async def send_json(self, payload: dict) -> None:
        if self.dead:
            raise RuntimeError("dead socket")
        self.sent.append(payload)


# ---------------------------------------------------------------------------
# AR1 – holder clean disconnect → auto-release broadcast, node lockable again
# ---------------------------------------------------------------------------


class TestCleanDisconnectAutoRelease:
    """Closing the holder's connection releases its locks for the peers."""

    def test_disconnect_broadcasts_node_unlocked_with_reason(self):
        services = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry, monitor = services
        app = _build_app(*services, _valid_user(user_id=10))

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=1&token=t"
            ) as ws_b:
                _drain_join(ws_b)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=1&token=t"
                ) as ws_a:
                    member_id_a = _drain_join(ws_a)
                    ws_b.receive_text()  # presence update (count=2)

                    # ws_a acquires node 42 and then disconnects (tab kill).
                    ws_a.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 1, "node_id": 42}
                        )
                    )
                    ws_a.receive_text()  # lock_granted
                    ws_a.receive_text()  # node_locked (ws_a)
                    ws_b.receive_text()  # node_locked (ws_b)

                    # Clean client close → endpoint finally → auto-release.
                    ws_a.close(1000)

                    unlocked = json.loads(ws_b.receive_text())
                    assert unlocked == {
                        "type": "node_unlocked",
                        "flow_id": 1,
                        "node_id": 42,
                        "origin": member_id_a,
                        "reason": "disconnected",
                    }

                    ws_b.receive_text()  # presence update (count=1)

                    # The node is lockable by ws_b afterwards.
                    ws_b.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 1, "node_id": 42}
                        )
                    )
                    granted = json.loads(ws_b.receive_text())
                    assert granted["type"] == "lock_granted"
                    assert granted["node_id"] == 42


class TestMultiNodeHolderDisconnect:
    """A holder with locks on several nodes releases ALL of them on disconnect."""

    def test_disconnect_releases_every_held_node(self):
        services = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry, monitor = services
        app = _build_app(*services, _valid_user(user_id=70))

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=9&token=t"
            ) as ws_b:
                _drain_join(ws_b)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=9&token=t"
                ) as ws_a:
                    member_id_a = _drain_join(ws_a)
                    ws_b.receive_text()  # presence update (count=2)

                    # ws_a acquires locks on TWO nodes, then disconnects.
                    for node_id in (21, 22):
                        ws_a.send_text(
                            json.dumps(
                                {
                                    "type": "lock_request",
                                    "flow_id": 9,
                                    "node_id": node_id,
                                }
                            )
                        )
                        ws_a.receive_text()  # lock_granted
                        ws_a.receive_text()  # node_locked (ws_a)
                        ws_b.receive_text()  # node_locked (ws_b)

                    # Clean client close → endpoint finally → auto-release of both.
                    ws_a.close(1000)

                    unlocked_by_node = {}
                    for _ in range(2):
                        frame = json.loads(ws_b.receive_text())
                        unlocked_by_node[frame["node_id"]] = frame
                    assert set(unlocked_by_node) == {21, 22}
                    for node_id, frame in unlocked_by_node.items():
                        assert frame == {
                            "type": "node_unlocked",
                            "flow_id": 9,
                            "node_id": node_id,
                            "origin": member_id_a,
                            "reason": "disconnected",
                        }

                    ws_b.receive_text()  # presence update (count=1)

                    # Both nodes are lockable by ws_b afterwards.
                    for node_id in (21, 22):
                        ws_b.send_text(
                            json.dumps(
                                {
                                    "type": "lock_request",
                                    "flow_id": 9,
                                    "node_id": node_id,
                                }
                            )
                        )
                        granted = json.loads(ws_b.receive_text())
                        assert granted["type"] == "lock_granted"
                        assert granted["node_id"] == node_id
                        ws_b.receive_text()  # node_locked broadcast (ws_b)


# ---------------------------------------------------------------------------
# AR2 – heartbeat timeout: sweep force-closes the zombie, lock is released
# ---------------------------------------------------------------------------


class TestSweepReleasesZombieHolder:
    """A silent connection is force-closed by the sweep; its lock is released."""

    def test_sweep_closes_silent_holder_and_releases_lock(self):
        clock = FakeClock()
        services = _make_services(clock=clock)
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry, monitor = services
        app = _build_app(*services, _valid_user(user_id=20))

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=2&token=t"
            ) as ws_b:
                _drain_join(ws_b)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=2&token=t"
                ) as ws_a:
                    member_id_a = _drain_join(ws_a)
                    ws_b.receive_text()  # presence update

                    ws_a.send_text(
                        json.dumps({"type": "lock_request", "flow_id": 2, "node_id": 7})
                    )
                    ws_a.receive_text()  # lock_granted
                    ws_a.receive_text()  # node_locked (ws_a)
                    ws_b.receive_text()  # node_locked (ws_b)

                    # ws_a goes silent past the liveness timeout; ws_b keeps
                    # heartbeating (which also exercises the ack contract).
                    clock.advance(LIVENESS_TIMEOUT_SECONDS + 1)
                    ws_b.send_text(json.dumps({"type": "heartbeat", "flow_id": 2}))
                    ack = json.loads(ws_b.receive_text())
                    assert ack == {"type": "heartbeat_ack", "flow_id": 2}

                    # Sweep runs on ws_a's session loop (where its ASGI send
                    # lives); only the silent ws_a expires.
                    expired = ws_a.portal.call(monitor.sweep_once)
                    assert len(expired) == 1

                    # The zombie socket — which looked open — got a
                    # server-side close.
                    with pytest.raises(WebSocketDisconnect) as excinfo:
                        ws_a.receive_text()
                    assert excinfo.value.code == 1001

                    # Deliver the transport disconnect (in production uvicorn
                    # follows the server close with it) → endpoint finally →
                    # auto-release broadcast.
                    ws_a.close(1000)

                    unlocked = json.loads(ws_b.receive_text())
                    assert unlocked == {
                        "type": "node_unlocked",
                        "flow_id": 2,
                        "node_id": 7,
                        "origin": member_id_a,
                        "reason": "disconnected",
                    }

                    ws_b.receive_text()  # presence update

                    ws_b.send_text(
                        json.dumps({"type": "lock_request", "flow_id": 2, "node_id": 7})
                    )
                    granted = json.loads(ws_b.receive_text())
                    assert granted["type"] == "lock_granted"
                    assert granted["node_id"] == 7


# ---------------------------------------------------------------------------
# AR3 – any inbound frame refreshes liveness
# ---------------------------------------------------------------------------


class TestAnyFrameRefreshesLiveness:
    """Non-heartbeat traffic counts as liveness — sweep must not expire it."""

    def test_inbound_frame_resets_silence_window(self):
        clock = FakeClock()
        services = _make_services(clock=clock)
        presence_svc, live_doc_svc, cursor_svc, lock_svc, registry, monitor = services
        app = _build_app(*services, _valid_user(user_id=30))

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=3&token=t") as ws:
                _drain_join(ws)

                ws.send_text(
                    json.dumps({"type": "lock_request", "flow_id": 3, "node_id": 1})
                )
                ws.receive_text()  # lock_granted
                ws.receive_text()  # node_locked

                # 20s of silence, then a NON-heartbeat frame (lock_request).
                clock.advance(20)
                ws.send_text(
                    json.dumps({"type": "lock_request", "flow_id": 3, "node_id": 2})
                )
                ws.receive_text()  # lock_granted — endpoint processed (touched)
                ws.receive_text()  # node_locked

                # 35s total since join, but only 15s since the last frame.
                clock.advance(15)
                expired = ws.portal.call(monitor.sweep_once)
                assert expired == []

                # Connection is still alive and locks are intact.
                assert set(lock_svc.lock_state(3).keys()) == {"1", "2"}
                ws.send_text(json.dumps({"type": "heartbeat", "flow_id": 3}))
                ack = json.loads(ws.receive_text())
                assert ack == {"type": "heartbeat_ack", "flow_id": 3}


# ---------------------------------------------------------------------------
# AR4 – heartbeat frame → heartbeat_ack to sender only
# ---------------------------------------------------------------------------


class TestHeartbeatAck:
    """A heartbeat frame is answered directly with heartbeat_ack, not broadcast."""

    def test_heartbeat_gets_direct_ack(self):
        services = _make_services()
        app = _build_app(*services, _valid_user(user_id=40))

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=4&token=t"
            ) as ws_a:
                _drain_join(ws_a)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=4&token=t"
                ) as ws_b:
                    _drain_join(ws_b)
                    ws_a.receive_text()  # presence update

                    ws_a.send_text(json.dumps({"type": "heartbeat", "flow_id": 4}))
                    ack = json.loads(ws_a.receive_text())
                    assert ack == {"type": "heartbeat_ack", "flow_id": 4}

                    # ws_b must NOT have received anything: its next frame
                    # after a lock_request from ws_b is the node_locked
                    # broadcast, with no intervening heartbeat traffic.
                    ws_b.send_text(
                        json.dumps({"type": "lock_request", "flow_id": 4, "node_id": 9})
                    )
                    next_b = json.loads(ws_b.receive_text())
                    assert next_b["type"] == "lock_granted"


# ---------------------------------------------------------------------------
# AR5 – reconnect after release: lock_state has no stale lock
# ---------------------------------------------------------------------------


class TestReconnectSeesCleanLockState:
    """A former holder reconnecting after auto-release sees no stale lock."""

    def test_rejoin_lock_state_excludes_released_lock(self):
        services = _make_services()
        app = _build_app(*services, _valid_user(user_id=50))

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=5&token=t"
            ) as ws_observer:
                _drain_join(ws_observer)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=5&token=t"
                ) as ws_old:
                    _drain_join(ws_old)
                    ws_observer.receive_text()  # presence update

                    ws_old.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 5, "node_id": 11}
                        )
                    )
                    ws_old.receive_text()  # lock_granted
                    ws_old.receive_text()  # node_locked (ws_old)
                    ws_observer.receive_text()  # node_locked (ws_observer)

                    # ws_old disconnects → auto-release; the observer's
                    # blocking receive synchronises on the release.
                    ws_old.close(1000)
                    unlocked = json.loads(ws_observer.receive_text())
                    assert unlocked["type"] == "node_unlocked"
                    ws_observer.receive_text()  # presence update

                    with client.websocket_connect(
                        "/realtime/collab/?flow_id=5&token=t"
                    ) as ws_new:
                        _, lock_state_msg = _drain_join_capture_lock_state(ws_new)
                        assert lock_state_msg["type"] == "lock_state"
                        assert lock_state_msg["locks"] == {}


# ---------------------------------------------------------------------------
# AR6 – member with no locks disconnecting is a no-op
# ---------------------------------------------------------------------------


class TestNoLockDisconnectIsNoop:
    """Disconnecting without holding locks must not emit node_unlocked."""

    def test_disconnect_without_locks_emits_no_unlock(self):
        services = _make_services()
        app = _build_app(*services, _valid_user(user_id=60))

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=6&token=t"
            ) as ws_a:
                _drain_join(ws_a)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=6&token=t"
                ) as ws_b:
                    _drain_join(ws_b)
                    ws_a.receive_text()  # presence update (count=2)

                    # ws_b (no locks) disconnects.
                    ws_b.close(1000)

                    # The very next frame on ws_a is the presence update —
                    # no node_unlocked was broadcast.
                    next_a = json.loads(ws_a.receive_text())
                    assert next_a["type"] == "presence"
                    assert next_a["count"] == 1


# ---------------------------------------------------------------------------
# AR7 – registry on_drop is multiplexed
# ---------------------------------------------------------------------------


class TestMultiplexedOnDrop:
    """Every registered on_drop callback fires for each dropped dead socket."""

    def test_all_callbacks_fire_for_dropped_socket(self):
        async def scenario():
            registry = CollabSocketRegistry()
            fired: list[tuple[str, object]] = []
            registry.add_on_drop(lambda ws: fired.append(("first", ws)))
            registry.add_on_drop(lambda ws: fired.append(("second", ws)))

            dead = _ScriptedSocket()
            dead.dead = True
            registry.register(1, dead)

            await registry.broadcast_json(1, {"type": "ping"})

            assert fired == [("first", dead), ("second", dead)]
            assert registry.sockets_for(1) == set()

        asyncio.run(scenario())


# ---------------------------------------------------------------------------
# AR8 – belt-and-braces: drop during broadcast purges presence AND locks
# ---------------------------------------------------------------------------


class TestDropDuringBroadcast:
    """A socket dying mid-broadcast loses its presence identity and its locks."""

    def test_presence_purge_and_lock_release_on_drop(self):
        async def scenario():
            services = _make_services()
            presence_svc, _, _, lock_svc, registry, monitor = services

            observer = _ScriptedSocket()
            zombie = _ScriptedSocket()

            await presence_svc.join(1, observer, user_id=1, display_name="Obs")
            zombie_member = await presence_svc.join(
                1, zombie, user_id=2, display_name="Zmb"
            )
            monitor.track(zombie, 1, zombie_member)

            await lock_svc.acquire(
                flow_id=1,
                node_id=5,
                member_id=zombie_member,
                user_id=2,
                websocket=zombie,
            )
            assert lock_svc.holder(1, 5) is not None

            # The zombie dies silently; the next broadcast detects it.
            zombie.dead = True
            await registry.broadcast_json(1, {"type": "ping"})
            await asyncio.sleep(0)  # let the on_drop release task run
            await asyncio.sleep(0)

            # Lock released and broadcast with the auto-release shape.
            assert lock_svc.holder(1, 5) is None
            unlocked = [msg for msg in observer.sent if msg["type"] == "node_unlocked"]
            assert unlocked == [
                {
                    "type": "node_unlocked",
                    "flow_id": 1,
                    "node_id": 5,
                    "origin": zombie_member,
                    "reason": "disconnected",
                }
            ]

            # Presence identity purged: the next presence broadcast lists
            # only the surviving participants.
            late = _ScriptedSocket()
            await presence_svc.join(1, late, user_id=3, display_name="Late")
            presence_frames = [
                msg for msg in observer.sent if msg["type"] == "presence"
            ]
            participant_user_ids = {
                participant["user_id"]
                for participant in presence_frames[-1]["participants"]
            }
            assert participant_user_ids == {1, 3}

        asyncio.run(scenario())
