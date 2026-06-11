"""Integration tests for the collab presence WebSocket endpoint.

Covers all four acceptance criteria:
  AC1 – invalid/missing token → close 1008
  AC2 – two clients on the same flow both receive count 2
  AC3 – one disconnect → remaining client receives count 1
  AC4 – connections on different flow_ids are fully isolated

EST-3 additions:
  AC6 – two connections with different identities → participants contains both
  AC7 – identity removed after leave
  AC8 – count is correct alongside participants

The test module builds a minimal FastAPI app around the real
``PresenceService`` + ``PresenceRepository`` backed by a FakeRedis client.
It never imports ``api.main`` or ``utils.auth`` (which require env vars and
optional third-party deps not installed in this environment).
"""

import asyncio
import json
from collections.abc import Callable
from types import SimpleNamespace

import fakeredis.aioredis as fake_aioredis
import pytest
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.testclient import TestClient

from application.collab_socket_registry import CollabSocketRegistry
from application.presence_service import PresenceService
from infrastructure.persistence.presence_repository import PresenceRepository


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_fake_repo() -> PresenceRepository:
    """Build a PresenceRepository backed by an in-process FakeRedis client."""
    fake_client = fake_aioredis.FakeRedis()
    fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
    return PresenceRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]


def _build_app(
    presence_service: PresenceService,
    introspect_fn: Callable[[str], dict | None],
) -> FastAPI:
    """Return a minimal FastAPI app that only exposes the collab presence route.

    ``introspect_fn`` is injected so tests never import ``utils.auth``
    (which pulls in ``core.config.settings`` and requires all env vars).
    """
    app = FastAPI()

    @app.websocket("/realtime/collab/")
    async def collab_presence(
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

        if flow_id is None:
            await websocket.close(code=1008)
            return

        await websocket.accept()
        member_id: str | None = None
        try:
            member_id = await presence_service.join(
                flow_id,
                websocket,
                user_id=user_info.get("user_id"),
                display_name=user_info.get("display_name"),
            )
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            if member_id is not None:
                await presence_service.leave(flow_id, websocket, member_id)

    return app


# A valid user payload returned by a successful token introspection.
_VALID_USER = {"active": True, "user_id": 1, "username": "test"}


def _valid_introspect(token: str) -> dict | None:
    return _VALID_USER


def _invalid_introspect(token: str) -> dict | None:
    return None


def _assert_presence_msg(msg: dict, *, flow_id: int, count: int) -> None:
    """Assert the presence-message fields that are stable under EST-2 contracts.

    Pins the exact envelope shape so stray keys are caught immediately.
    The EST-3 ``participants`` field is additive — assert its type but not its
    exact contents here (dedicated AC6/AC7/AC8 tests cover that).
    The EST-7 ``designated_member_id`` field is additive — assert its presence
    but not its exact value here (dedicated FC2/FC3 tests cover that).
    """
    assert set(msg.keys()) == {
        "type",
        "flow_id",
        "count",
        "participants",
        "designated_member_id",
    }
    assert msg["type"] == "presence"
    assert msg["flow_id"] == flow_id
    assert msg["count"] == count
    assert isinstance(msg["participants"], list)
    # designated_member_id is str | None
    assert msg["designated_member_id"] is None or isinstance(
        msg["designated_member_id"], str
    )


# ---------------------------------------------------------------------------
# AC1 – authentication failures close with code 1008
# ---------------------------------------------------------------------------


class TestAuthRejection:
    """Missing or invalid tokens must cause an abnormal close (1008)."""

    def test_missing_token_closes_1008(self):
        service = PresenceService(
            repository=_make_fake_repo(), registry=CollabSocketRegistry()
        )
        app = _build_app(service, _valid_introspect)

        with TestClient(app) as client:
            with pytest.raises(Exception):
                # Starlette TestClient raises WebSocketDenied / similar on 1008.
                with client.websocket_connect("/realtime/collab/?flow_id=1") as ws:
                    ws.receive_text()

    def test_invalid_token_closes_1008(self):
        service = PresenceService(
            repository=_make_fake_repo(), registry=CollabSocketRegistry()
        )
        app = _build_app(service, _invalid_introspect)

        with TestClient(app) as client:
            with pytest.raises(Exception):
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=1&token=bad"
                ) as ws:
                    ws.receive_text()

    def test_missing_flow_id_closes_1008(self):
        service = PresenceService(
            repository=_make_fake_repo(), registry=CollabSocketRegistry()
        )
        app = _build_app(service, _valid_introspect)

        with TestClient(app) as client:
            with pytest.raises(Exception):
                with client.websocket_connect("/realtime/collab/?token=valid") as ws:
                    ws.receive_text()


# ---------------------------------------------------------------------------
# AC2 – two clients on the same flow both receive count 2
# ---------------------------------------------------------------------------


class TestTwoClientsOnSameFlow:
    """Second connection broadcasts count 2 to all sockets on the flow."""

    def test_second_join_broadcasts_count_two_to_both(self):
        repo = _make_fake_repo()
        service = PresenceService(repository=repo, registry=CollabSocketRegistry())
        app = _build_app(service, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=10&token=t"
            ) as ws1:
                # First join → count 1 (only ws1 in the flow).
                msg1 = json.loads(ws1.receive_text())
                _assert_presence_msg(msg1, flow_id=10, count=1)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=10&token=t"
                ) as ws2:
                    # ws2 just joined — it receives its own join broadcast.
                    msg_ws2 = json.loads(ws2.receive_text())
                    _assert_presence_msg(msg_ws2, flow_id=10, count=2)
                    # ws1 also received the broadcast when ws2 joined.
                    msg_ws1_update = json.loads(ws1.receive_text())
                    _assert_presence_msg(msg_ws1_update, flow_id=10, count=2)


# ---------------------------------------------------------------------------
# AC3 – disconnect → remaining connections receive decremented count
# ---------------------------------------------------------------------------


class TestDisconnectDecrementsCount:
    """When a socket disconnects, the remaining sockets receive count - 1."""

    def test_leave_broadcasts_count_one_to_remaining(self):
        repo = _make_fake_repo()
        service = PresenceService(repository=repo, registry=CollabSocketRegistry())
        app = _build_app(service, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=20&token=t"
            ) as ws1:
                # Consume join broadcast (count 1).
                ws1.receive_text()

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=20&token=t"
                ) as ws2:
                    # Consume ws2's own join broadcast.
                    ws2.receive_text()
                    # Consume the same broadcast on ws1.
                    ws1.receive_text()

                # ws2 context exited → disconnect → `leave` fires → count drops to 1.
                # ws1 must receive the decremented count.
                leave_msg = json.loads(ws1.receive_text())
                _assert_presence_msg(leave_msg, flow_id=20, count=1)


# ---------------------------------------------------------------------------
# AC4 – different flow_ids are fully isolated
# ---------------------------------------------------------------------------


class TestFlowIsolation:
    """Connections on different flows must not affect each other's counts."""

    def test_different_flows_see_independent_counts(self):
        repo = _make_fake_repo()
        service = PresenceService(repository=repo, registry=CollabSocketRegistry())
        app = _build_app(service, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=100&token=t"
            ) as ws_flow_100:
                # flow 100 starts at 1.
                msg_100 = json.loads(ws_flow_100.receive_text())
                _assert_presence_msg(msg_100, flow_id=100, count=1)

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=200&token=t"
                ) as ws_flow_200:
                    # flow 200 starts independently at 1.
                    msg_200 = json.loads(ws_flow_200.receive_text())
                    _assert_presence_msg(msg_200, flow_id=200, count=1)

                # ws_flow_200 disconnected: flow 200 count drops to 0.
                # Verify Redis counts reflect isolation.
                count_100 = asyncio.run(repo.count(100))
                count_200 = asyncio.run(repo.count(200))

                assert count_100 == 1, f"flow 100 count should be 1, got {count_100}"
                assert count_200 == 0, f"flow 200 count should be 0, got {count_200}"

            # ws_flow_100 also disconnected now.
            final_100 = asyncio.run(repo.count(100))
            assert (
                final_100 == 0
            ), f"flow 100 should be 0 after ws disconnect, got {final_100}"


# ---------------------------------------------------------------------------
# AC5 – Redis failure during join leaves no local socket registered
# ---------------------------------------------------------------------------


class TestJoinRedisFailure:
    """If Redis raises during join, no socket must be registered locally and
    a second client on the same flow must see a correct count of 1."""

    def test_redis_failure_leaves_no_local_socket_and_route_closes_cleanly(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        repo = _make_fake_repo()
        registry = CollabSocketRegistry()
        service = PresenceService(repository=repo, registry=registry)
        app = _build_app(service, _valid_introspect)

        # Patch add_member to raise only on the first call, simulating a Redis
        # failure during the first client's join.
        original_add_member = repo.add_member
        call_count = 0

        async def _failing_add_member(flow_id: int, member_id: str) -> None:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("simulated Redis failure")
            await original_add_member(flow_id, member_id)

        monkeypatch.setattr(repo, "add_member", _failing_add_member)

        with TestClient(app) as client:
            # First connection: join fails at Redis — route must close without
            # NameError and the socket must NOT be in the registry.
            with pytest.raises(Exception):
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=42&token=t"
                ) as ws_bad:
                    ws_bad.receive_text()

            # No local socket must remain after the failed join.
            assert len(registry.sockets_for(42)) == 0

            # Second connection succeeds normally.
            with client.websocket_connect(
                "/realtime/collab/?flow_id=42&token=t"
            ) as ws_ok:
                msg = json.loads(ws_ok.receive_text())
                # Redis has exactly 1 member; local count matches.
                _assert_presence_msg(msg, flow_id=42, count=1)


# ---------------------------------------------------------------------------
# AC6 – two connections with different identities → participants contains both
# ---------------------------------------------------------------------------


class TestParticipantsIdentity:
    """EST-3: presence broadcast carries per-connection identity."""

    def _make_user_introspect(self, user_id: int, display_name: str | None):
        def introspect(token: str) -> dict | None:
            return {
                "active": True,
                "user_id": user_id,
                "display_name": display_name,
            }

        return introspect

    def test_two_connections_participants_contains_both_identities(self):
        repo = _make_fake_repo()
        registry = CollabSocketRegistry()
        service = PresenceService(repository=repo, registry=registry)

        # Build an app that routes by token value to different identities.
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
            member_id: str | None = None
            try:
                member_id = await service.join(
                    flow_id,
                    websocket,
                    user_id=user_info.get("user_id"),
                    display_name=user_info.get("display_name"),
                )
                while True:
                    await websocket.receive_text()
            except WebSocketDisconnect:
                pass
            finally:
                if member_id is not None:
                    await service.leave(flow_id, websocket, member_id)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=300&token=token-alice"
            ) as ws_alice:
                # Alice joins → count 1, participants = [Alice].
                msg_alice_join = json.loads(ws_alice.receive_text())
                assert msg_alice_join["count"] == 1
                # EST-11: participants carry additional keys (e.g. is_viewer);
                # check the required fields only to stay additive-field safe.
                assert len(msg_alice_join["participants"]) == 1
                p = msg_alice_join["participants"][0]
                assert p["user_id"] == 10
                assert p["display_name"] == "Alice"

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=300&token=token-bob"
                ) as ws_bob:
                    # Bob joins → count 2, both receive updated participants.
                    msg_bob_join = json.loads(ws_bob.receive_text())
                    assert msg_bob_join["count"] == 2
                    assert len(msg_bob_join["participants"]) == 2

                    # Alice also receives the broadcast.
                    msg_alice_update = json.loads(ws_alice.receive_text())
                    assert msg_alice_update["count"] == 2
                    assert len(msg_alice_update["participants"]) == 2

                    # Both participants present with correct fields.
                    user_ids = {p["user_id"] for p in msg_alice_update["participants"]}
                    assert user_ids == {10, 20}
                    display_names = {
                        p["display_name"] for p in msg_alice_update["participants"]
                    }
                    assert display_names == {"Alice", "Bob"}

    def test_identity_removed_after_leave(self):
        repo = _make_fake_repo()
        registry = CollabSocketRegistry()
        service = PresenceService(repository=repo, registry=registry)

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
            member_id: str | None = None
            try:
                member_id = await service.join(
                    flow_id,
                    websocket,
                    user_id=user_info.get("user_id"),
                    display_name=user_info.get("display_name"),
                )
                while True:
                    await websocket.receive_text()
            except WebSocketDisconnect:
                pass
            finally:
                if member_id is not None:
                    await service.leave(flow_id, websocket, member_id)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=400&token=token-alice"
            ) as ws_alice:
                ws_alice.receive_text()  # Alice join broadcast

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=400&token=token-bob"
                ) as ws_bob:
                    ws_bob.receive_text()  # Bob join broadcast
                    ws_alice.receive_text()  # Alice receives Bob's join broadcast

                # Bob disconnected — Alice must get a leave broadcast.
                leave_msg = json.loads(ws_alice.receive_text())
                assert leave_msg["count"] == 1
                # Only Alice's identity remains.
                # EST-11: participants carry additional keys (e.g. is_viewer);
                # check the required fields only to stay additive-field safe.
                assert len(leave_msg["participants"]) == 1
                p = leave_msg["participants"][0]
                assert p["user_id"] == 10
                assert p["display_name"] == "Alice"

    def test_display_name_null_is_preserved_in_participants(self):
        """display_name=None is preserved as null in the participants list."""
        repo = _make_fake_repo()
        registry = CollabSocketRegistry()
        service = PresenceService(repository=repo, registry=registry)

        def introspect_no_display(token: str) -> dict | None:
            return {"active": True, "user_id": 5, "display_name": None}

        app = _build_app(service, introspect_no_display)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=500&token=t"
            ) as ws:
                msg = json.loads(ws.receive_text())
                assert msg["count"] == 1
                # EST-11: participants carry additional keys (e.g. is_viewer);
                # check the required fields only to stay additive-field safe.
                assert len(msg["participants"]) == 1
                p = msg["participants"][0]
                assert p["user_id"] == 5
                assert p["display_name"] is None
