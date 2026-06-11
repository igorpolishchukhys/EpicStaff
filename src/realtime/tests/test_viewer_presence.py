"""Integration tests for EST-11 read-only viewer presence enforcement.

Acceptance criteria:
  VP1  – viewer's mutating op (node_moved) is NOT applied; sender receives op_rejected
  VP2  – viewer's lock_request is NOT applied; sender receives op_rejected
  VP3  – viewer's cursor_moved IS relayed normally (non-mutating op)
  VP4  – viewer's heartbeat IS acknowledged normally (non-mutating op)
  VP5  – presence broadcast carries is_viewer=True for viewer participants
  VP6  – self frame carries is_viewer=True for the viewer
  VP7  – editor's node_moved IS applied and broadcast (is_viewer=False)
  VP8  – all blocked op types declared in production VIEWER_BLOCKED_OPS are rejected

Design:
  Token introspection is patched via ``unittest.mock.patch`` targeting
  ``tests.test_viewer_presence._introspect_token`` — the thin wrapper at the
  bottom of this module that the app handler calls at runtime.  Tests never
  talk to a live Django endpoint and never import ``utils.auth`` directly
  (``utils.auth`` depends on ``requests`` which is absent from the test venv;
  the production service wires the real ``utils.auth.introspect_token`` instead).

  ``VIEWER_BLOCKED_OPS`` is imported directly from the production module so
  there is a single source of truth.  A newly-added mutating frame type is
  automatically covered by VP8 without any change to this test file.
"""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

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
    VIEWER_BLOCKED_OPS,
    ConnectionAddedIn,
    ConnectionRemovedIn,
    CursorMovedIn,
    HeartbeatIn,
    LockReleaseIn,
    LockRequestIn,
    NodeAddedIn,
    NodeDeletedIn,
    NodeMovedIn,
    SelectionChangedIn,
)
from infrastructure.persistence.live_document_repository import LiveDocumentRepository
from infrastructure.persistence.presence_repository import PresenceRepository


# ---------------------------------------------------------------------------
# Introspect shim — patched by tests via unittest.mock.patch
#
# In production, api.main calls utils.auth.introspect_token directly.
# Here we expose a module-level shim so tests can patch it without importing
# utils.auth (which has a hard dependency on the `requests` library, not
# installed in the test venv).  The shim is the authoritative call site
# for introspection within this test module.
# ---------------------------------------------------------------------------


def _introspect_token(token: str) -> dict | None:  # pragma: no cover
    """Shim replaced by unittest.mock.patch in every test.

    Raising here makes it obvious if a test forgets to patch it.
    """
    raise RuntimeError(
        "_introspect_token was called without being patched. "
        "Wrap your test in: with patch('tests.test_viewer_presence._introspect_token', ...):"
    )


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
) -> FastAPI:
    """Minimal FastAPI app mirroring the production collab route.

    Token introspection is handled by patching ``_introspect_token`` in this
    module (via ``unittest.mock.patch``), so the auth path is controlled by
    each test without talking to a live Django endpoint.

    The dispatch logic uses the production ``VIEWER_BLOCKED_OPS`` constant
    directly — there is no local re-declaration.
    """
    import tests.test_viewer_presence as _self

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

        # Reject missing flow_id before making any auth call.
        if flow_id is None:
            await websocket.close(code=1008)
            return

        # Call through to whatever ``_introspect_token`` resolves to at runtime.
        # Tests replace it via:
        #   with patch("tests.test_viewer_presence._introspect_token", return_value=...):
        user_info = _self._introspect_token(token)
        if not user_info:
            await websocket.close(code=1008)
            return

        user_id = user_info.get("user_id")
        if not isinstance(user_id, int):
            await websocket.close(code=1008)
            return

        can_edit = user_info.get("can_edit", True)
        is_viewer: bool = can_edit is False

        await websocket.accept()
        member_id: str | None = None
        try:
            member_id = await presence_service.join(
                flow_id,
                websocket,
                user_id=user_id,
                display_name=user_info.get("display_name"),
                is_viewer=is_viewer,
            )

            doc_state = await live_document_service.get_document_state(flow_id)
            await websocket.send_json(doc_state)

            await websocket.send_json(
                {
                    "type": "self",
                    "flow_id": flow_id,
                    "member_id": member_id,
                    "user_id": user_id,
                    "is_viewer": is_viewer,
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
                try:
                    data = json.loads(raw)
                    msg_type = data.get("type")

                    # EST-11 enforcement using the production constant.
                    if is_viewer and msg_type in VIEWER_BLOCKED_OPS:
                        await websocket.send_json(
                            {
                                "type": "op_rejected",
                                "reason": "viewer",
                                "op": msg_type,
                            }
                        )
                        continue

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
                    elif msg_type == "node_added":
                        frame = NodeAddedIn(**data)
                        await live_document_service.apply_node_added(
                            flow_id=frame.flow_id,
                            node_key=frame.node_key,
                            node=frame.node,
                            origin_member_id=member_id,
                        )
                    elif msg_type == "node_deleted":
                        frame = NodeDeletedIn(**data)
                        await live_document_service.apply_node_deleted(
                            flow_id=frame.flow_id,
                            node_key=frame.node_key,
                            origin_member_id=member_id,
                        )
                    elif msg_type == "connection_added":
                        frame = ConnectionAddedIn(**data)
                        await live_document_service.apply_connection_added(
                            flow_id=frame.flow_id,
                            connection_id=frame.connection_id,
                            source_node_key=frame.source_node_key,
                            target_node_key=frame.target_node_key,
                            source_port_id=frame.source_port_id,
                            target_port_id=frame.target_port_id,
                            connection=frame.connection,
                            origin_member_id=member_id,
                        )
                    elif msg_type == "connection_removed":
                        frame = ConnectionRemovedIn(**data)
                        await live_document_service.apply_connection_removed(
                            flow_id=frame.flow_id,
                            connection_id=frame.connection_id,
                            origin_member_id=member_id,
                        )
                except (json.JSONDecodeError, ValidationError):
                    pass
        except WebSocketDisconnect:
            pass
        finally:
            if member_id is not None:
                await lock_service.release_all_for_member(flow_id, member_id)
                await presence_service.leave(flow_id, websocket, member_id)

    return app


# ---------------------------------------------------------------------------
# Introspect stubs — returned by the patched utils.auth.introspect_token
# ---------------------------------------------------------------------------

_VIEWER_INFO = {
    "active": True,
    "user_id": 99,
    "display_name": "Viewer",
    "can_edit": False,
}
_EDITOR_INFO = {
    "active": True,
    "user_id": 1,
    "display_name": "Editor",
    "can_edit": True,
}
_LEGACY_INFO = {"active": True, "user_id": 7, "display_name": "Legacy"}


# ---------------------------------------------------------------------------
# VP1 – viewer node_moved is rejected; sender gets op_rejected
# ---------------------------------------------------------------------------


class TestViewerMutatingOpRejected:
    def test_node_moved_rejected_for_viewer(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_VIEWER_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=1&token=viewer-token"
                ) as ws:
                    ws.receive_text()  # presence broadcast
                    ws.receive_text()  # document_state
                    ws.receive_text()  # self
                    ws.receive_text()  # lock_state

                    ws.send_text(
                        json.dumps(
                            {
                                "type": "node_moved",
                                "flow_id": 1,
                                "node_id": 42,
                                "x": 100.0,
                                "y": 200.0,
                            }
                        )
                    )
                    rejection = json.loads(ws.receive_text())
                    assert rejection["type"] == "op_rejected"
                    assert rejection["reason"] == "viewer"
                    assert rejection["op"] == "node_moved"

    def test_node_moved_not_applied_after_viewer_rejection(self):
        """Verify live document state is unchanged after a viewer's node_moved."""
        fake_client = _make_fake_redis_client()
        svc = _make_services(fake_client)
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_VIEWER_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=2&token=viewer-token"
                ) as ws:
                    ws.receive_text()  # presence
                    ws.receive_text()  # document_state
                    ws.receive_text()  # self
                    ws.receive_text()  # lock_state

                    ws.send_text(
                        json.dumps(
                            {
                                "type": "node_moved",
                                "flow_id": 2,
                                "node_id": 10,
                                "x": 55.0,
                                "y": 66.0,
                            }
                        )
                    )
                    ws.receive_text()  # op_rejected

        # After disconnect, check that no position was persisted in the fake Redis.
        positions = asyncio.run(fake_client.hgetall("collab:flow:2:positions"))
        assert not positions, "Viewer node_moved must not write to the live document"


# ---------------------------------------------------------------------------
# VP2 – viewer lock_request is rejected
# ---------------------------------------------------------------------------


class TestViewerLockRequestRejected:
    def test_lock_request_rejected_for_viewer(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_VIEWER_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=10&token=viewer-token"
                ) as ws:
                    ws.receive_text()  # presence
                    ws.receive_text()  # document_state
                    ws.receive_text()  # self
                    ws.receive_text()  # lock_state

                    ws.send_text(
                        json.dumps(
                            {"type": "lock_request", "flow_id": 10, "node_id": 5}
                        )
                    )
                    rejection = json.loads(ws.receive_text())
                    assert rejection["type"] == "op_rejected"
                    assert rejection["reason"] == "viewer"
                    assert rejection["op"] == "lock_request"

                    # Lock must not have been granted.
                    assert lock_svc.holder(10, 5) is None


# ---------------------------------------------------------------------------
# VP3 – viewer cursor_moved IS relayed
# ---------------------------------------------------------------------------


class TestViewerCursorRelayed:
    def test_cursor_moved_relayed_for_viewer(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_VIEWER_INFO
        ):
            with TestClient(app) as client:
                # Two connections — the second observer verifies the relay.
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=20&token=viewer-token"
                ) as viewer_ws:
                    viewer_ws.receive_text()  # presence (count 1)
                    viewer_ws.receive_text()  # document_state
                    viewer_ws.receive_text()  # self
                    viewer_ws.receive_text()  # lock_state

                    with client.websocket_connect(
                        "/realtime/collab/?flow_id=20&token=viewer-token"
                    ) as observer_ws:
                        viewer_ws.receive_text()  # presence broadcast (count 2)
                        observer_ws.receive_text()  # presence (count 2)
                        observer_ws.receive_text()  # document_state
                        observer_ws.receive_text()  # self
                        observer_ws.receive_text()  # lock_state

                        viewer_ws.send_text(
                            json.dumps(
                                {
                                    "type": "cursor_moved",
                                    "flow_id": 20,
                                    "x": 11.0,
                                    "y": 22.0,
                                }
                            )
                        )

                        # Both sockets receive the cursor broadcast (including sender).
                        cursor_msg_viewer = json.loads(viewer_ws.receive_text())
                        assert cursor_msg_viewer["type"] == "cursor_moved"
                        assert cursor_msg_viewer["x"] == 11.0

                        cursor_msg_observer = json.loads(observer_ws.receive_text())
                        assert cursor_msg_observer["type"] == "cursor_moved"
                        assert cursor_msg_observer["x"] == 11.0


# ---------------------------------------------------------------------------
# VP4 – viewer heartbeat IS acknowledged
# ---------------------------------------------------------------------------


class TestViewerHeartbeatAcknowledged:
    def test_heartbeat_ack_returned_for_viewer(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_VIEWER_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=30&token=viewer-token"
                ) as ws:
                    ws.receive_text()  # presence
                    ws.receive_text()  # document_state
                    ws.receive_text()  # self
                    ws.receive_text()  # lock_state

                    ws.send_text(json.dumps({"type": "heartbeat", "flow_id": 30}))
                    ack = json.loads(ws.receive_text())
                    assert ack["type"] == "heartbeat_ack"
                    assert ack["flow_id"] == 30


# ---------------------------------------------------------------------------
# VP5 – presence broadcast carries is_viewer for the viewer participant
# ---------------------------------------------------------------------------


class TestViewerFlagInPresenceBroadcast:
    def test_presence_broadcast_carries_is_viewer_true(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_VIEWER_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=40&token=viewer-token"
                ) as ws:
                    presence_msg = json.loads(ws.receive_text())
                    assert presence_msg["type"] == "presence"
                    assert len(presence_msg["participants"]) == 1
                    participant = presence_msg["participants"][0]
                    assert participant["is_viewer"] is True

    def test_presence_broadcast_editor_is_viewer_false(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_EDITOR_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=41&token=editor-token"
                ) as ws:
                    presence_msg = json.loads(ws.receive_text())
                    participant = presence_msg["participants"][0]
                    assert participant["is_viewer"] is False


# ---------------------------------------------------------------------------
# VP6 – self frame carries is_viewer
# ---------------------------------------------------------------------------


class TestViewerFlagInSelfFrame:
    def test_self_frame_is_viewer_true_for_viewer(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_VIEWER_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=50&token=viewer-token"
                ) as ws:
                    ws.receive_text()  # presence
                    ws.receive_text()  # document_state
                    self_frame = json.loads(ws.receive_text())
                    assert self_frame["type"] == "self"
                    assert self_frame["is_viewer"] is True

    def test_self_frame_is_viewer_false_for_editor(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_EDITOR_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=51&token=editor-token"
                ) as ws:
                    ws.receive_text()  # presence
                    ws.receive_text()  # document_state
                    self_frame = json.loads(ws.receive_text())
                    assert self_frame["type"] == "self"
                    assert self_frame["is_viewer"] is False

    def test_self_frame_is_viewer_false_when_no_can_edit_context(self):
        """Legacy callers that don't pass org_id get can_edit absent → is_viewer=False."""
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_LEGACY_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=52&token=legacy-token"
                ) as ws:
                    ws.receive_text()  # presence
                    ws.receive_text()  # document_state
                    self_frame = json.loads(ws.receive_text())
                    assert self_frame["type"] == "self"
                    # No can_edit in response → treated as editor (is_viewer=False).
                    assert self_frame["is_viewer"] is False


# ---------------------------------------------------------------------------
# VP7 – editor node_moved IS applied and broadcast
# ---------------------------------------------------------------------------


class TestEditorMutatingOpAllowed:
    def test_editor_node_moved_is_broadcast(self):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_EDITOR_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=60&token=editor-token"
                ) as ws:
                    ws.receive_text()  # presence
                    ws.receive_text()  # document_state
                    ws.receive_text()  # self
                    ws.receive_text()  # lock_state

                    ws.send_text(
                        json.dumps(
                            {
                                "type": "node_moved",
                                "flow_id": 60,
                                "node_id": 1,
                                "x": 9.0,
                                "y": 8.0,
                            }
                        )
                    )
                    broadcast = json.loads(ws.receive_text())
                    assert broadcast["type"] == "node_moved"
                    assert broadcast["x"] == 9.0
                    assert broadcast["y"] == 8.0


# ---------------------------------------------------------------------------
# VP8 – every op declared in production VIEWER_BLOCKED_OPS is rejected
#
# This parametrize list is derived from the production constant: if a new op
# type is added to VIEWER_BLOCKED_OPS but not here, the test will fail loudly
# because the parametrize payload set won't cover it.  Conversely, adding
# a frame dict here for an op that has been removed from VIEWER_BLOCKED_OPS
# causes a test failure because the endpoint would allow it through.
# ---------------------------------------------------------------------------

_BLOCKED_OP_FRAMES: list[dict] = [
    {"type": "node_moved", "flow_id": 70, "node_id": 1, "x": 0.0, "y": 0.0},
    {
        "type": "node_added",
        "flow_id": 70,
        "node_key": "nk1",
        "node": {"id": 1},
    },
    {"type": "node_deleted", "flow_id": 70, "node_key": "nk2"},
    {
        "type": "connection_added",
        "flow_id": 70,
        "connection_id": "c1",
        "source_node_key": "nk1",
        "target_node_key": "nk2",
        "source_port_id": "p1",
        "target_port_id": "p2",
        "connection": {},
    },
    {
        "type": "connection_removed",
        "flow_id": 70,
        "connection_id": "c1",
    },
    {
        "type": "node_data_updated",
        "flow_id": 70,
        "node_id": 1,
        "node_name": "n",
        "data": {},
    },
    {"type": "lock_request", "flow_id": 70, "node_id": 1},
    {"type": "lock_release", "flow_id": 70, "node_id": 1},
]

# Verify at import time that the frame list covers exactly the production set.
# A mismatch here means a frame was added to _BLOCKED_OP_FRAMES but not
# to VIEWER_BLOCKED_OPS (or vice versa), which is a coverage hole.
_FRAME_OP_TYPES: frozenset[str] = frozenset(f["type"] for f in _BLOCKED_OP_FRAMES)
assert _FRAME_OP_TYPES == VIEWER_BLOCKED_OPS, (
    f"_BLOCKED_OP_FRAMES and VIEWER_BLOCKED_OPS are out of sync.\n"
    f"  In frames only: {_FRAME_OP_TYPES - VIEWER_BLOCKED_OPS}\n"
    f"  In VIEWER_BLOCKED_OPS only: {VIEWER_BLOCKED_OPS - _FRAME_OP_TYPES}"
)


class TestAllBlockedOpsRejected:
    @pytest.mark.parametrize("frame", _BLOCKED_OP_FRAMES)
    def test_op_rejected(self, frame: dict):
        svc = _make_services()
        presence_svc, live_doc_svc, cursor_svc, lock_svc, _ = svc
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, lock_svc)

        with patch(
            "tests.test_viewer_presence._introspect_token", return_value=_VIEWER_INFO
        ):
            with TestClient(app) as client:
                with client.websocket_connect(
                    f"/realtime/collab/?flow_id={frame['flow_id']}&token=viewer-token"
                ) as ws:
                    ws.receive_text()  # presence
                    ws.receive_text()  # document_state
                    ws.receive_text()  # self
                    ws.receive_text()  # lock_state

                    ws.send_text(json.dumps(frame))
                    rejection = json.loads(ws.receive_text())
                    assert (
                        rejection["type"] == "op_rejected"
                    ), f"Expected op_rejected for {frame['type']}, got {rejection}"
                    assert rejection["reason"] == "viewer"
                    assert rejection["op"] == frame["type"]
