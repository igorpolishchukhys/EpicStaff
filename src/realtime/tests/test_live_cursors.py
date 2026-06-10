"""Integration tests for live cursors and selection outlines (EST-4).

Covers:
  LC1 – joiner receives the ``self`` frame (member_id + user_id) after document_state
  LC2 – cursor_moved from A reaches A and B with origin=A's member_id and A's user_id
  LC3 – selection_changed relays likewise
  LC4 – cursor/selection events do NOT write any Redis key
  LC5 – cursor_moved on flow 1 does NOT reach flow 2's sockets
  LC6 – malformed cursor_moved frame is ignored, socket stays alive
"""

import asyncio
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
from application.presence_service import PresenceService
from domain.models.collab_messages import CursorMovedIn, NodeMovedIn, SelectionChangedIn
from infrastructure.persistence.live_document_repository import LiveDocumentRepository
from infrastructure.persistence.presence_repository import PresenceRepository


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_fake_redis_client() -> fake_aioredis.FakeRedis:
    return fake_aioredis.FakeRedis(decode_responses=True)


def _make_services(
    fake_client: fake_aioredis.FakeRedis | None = None,
) -> tuple[
    PresenceService,
    LiveDocumentService,
    CursorService,
    CollabSocketRegistry,
    fake_aioredis.FakeRedis,
]:
    """Build wired services backed by a shared in-process FakeRedis."""
    if fake_client is None:
        fake_client = _make_fake_redis_client()

    fake_redis_service = SimpleNamespace(aioredis_client=fake_client)

    presence_repo = PresenceRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    live_doc_repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    registry = CollabSocketRegistry()
    presence_svc = PresenceService(repository=presence_repo, registry=registry)
    live_doc_svc = LiveDocumentService(registry=registry, repository=live_doc_repo)
    cursor_svc = CursorService(registry=registry)

    return presence_svc, live_doc_svc, cursor_svc, registry, fake_client


def _build_app(
    presence_service: PresenceService,
    live_document_service: LiveDocumentService,
    cursor_service: CursorService,
    introspect_fn: Callable[[str], dict | None],
) -> FastAPI:
    """Minimal FastAPI app mirroring the production collab route including EST-4."""
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

            # Send document state snapshot to the joining socket.
            doc_state = await live_document_service.get_document_state(flow_id)
            await websocket.send_json(doc_state)

            # Send self frame immediately after document_state.
            await websocket.send_json(
                {
                    "type": "self",
                    "flow_id": flow_id,
                    "member_id": member_id,
                    "user_id": user_id,
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
                    # unknown type → silently ignore
                except (json.JSONDecodeError, ValidationError, Exception):
                    pass  # malformed → ignore, do not close
        except WebSocketDisconnect:
            pass
        finally:
            if member_id is not None:
                await presence_service.leave(flow_id, websocket, member_id)

    return app


_VALID_USER = {"active": True, "user_id": 7, "display_name": "TestUser"}


def _valid_introspect(token: str) -> dict | None:
    return _VALID_USER


# ---------------------------------------------------------------------------
# LC1 – joiner receives the self frame after document_state
# ---------------------------------------------------------------------------


class TestSelfFrame:
    """The joining socket must receive a self frame with its member_id and user_id."""

    def test_joiner_receives_self_frame_after_document_state(self):
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=1&token=t") as ws:
                # 1. presence broadcast
                presence_msg = json.loads(ws.receive_text())
                assert presence_msg["type"] == "presence"

                # 2. document_state
                doc_state = json.loads(ws.receive_text())
                assert doc_state["type"] == "document_state"

                # 3. self frame
                self_msg = json.loads(ws.receive_text())
                assert self_msg["type"] == "self"
                assert self_msg["flow_id"] == 1
                assert self_msg["user_id"] == 7
                # member_id must be a non-empty string (uuid4 hex)
                assert isinstance(self_msg["member_id"], str)
                assert len(self_msg["member_id"]) > 0

    def test_self_frame_member_id_matches_origin_on_broadcast(self):
        """The member_id from self must equal the origin on subsequent broadcasts."""
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=2&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state
                self_msg = json.loads(ws.receive_text())
                my_member_id = self_msg["member_id"]

                ws.send_text(
                    json.dumps(
                        {"type": "cursor_moved", "flow_id": 2, "x": 10.0, "y": 20.0}
                    )
                )
                cursor_broadcast = json.loads(ws.receive_text())
                assert cursor_broadcast["origin"] == my_member_id


# ---------------------------------------------------------------------------
# LC2 – cursor_moved reaches both sender and peer
# ---------------------------------------------------------------------------


class TestCursorMovedBroadcast:
    """cursor_moved from A must reach A and B with origin=A's member_id and user_id."""

    def test_cursor_moved_reaches_sender_and_peer(self):
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=10&token=t"
            ) as ws_a:
                ws_a.receive_text()  # presence count=1
                ws_a.receive_text()  # document_state
                self_a = json.loads(ws_a.receive_text())
                member_id_a = self_a["member_id"]

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=10&token=t"
                ) as ws_b:
                    ws_b.receive_text()  # presence count=2
                    ws_b.receive_text()  # document_state
                    ws_b.receive_text()  # self
                    ws_a.receive_text()  # presence count=2 rebroadcast to A

                    # A sends a cursor_moved frame.
                    ws_a.send_text(
                        json.dumps(
                            {
                                "type": "cursor_moved",
                                "flow_id": 10,
                                "x": 55.5,
                                "y": 88.0,
                            }
                        )
                    )

                    msg_a = json.loads(ws_a.receive_text())
                    msg_b = json.loads(ws_b.receive_text())

                    for msg in (msg_a, msg_b):
                        assert msg["type"] == "cursor_moved"
                        assert msg["flow_id"] == 10
                        assert msg["x"] == 55.5
                        assert msg["y"] == 88.0
                        assert msg["origin"] == member_id_a
                        assert msg["user_id"] == 7

                    # Both must carry the same origin.
                    assert msg_a["origin"] == msg_b["origin"]


# ---------------------------------------------------------------------------
# LC3 – selection_changed relays likewise
# ---------------------------------------------------------------------------


class TestSelectionChangedBroadcast:
    """selection_changed from A must reach A and B with origin=A's member_id and user_id."""

    def test_selection_changed_reaches_sender_and_peer(self):
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=20&token=t"
            ) as ws_a:
                ws_a.receive_text()  # presence count=1
                ws_a.receive_text()  # document_state
                self_a = json.loads(ws_a.receive_text())
                member_id_a = self_a["member_id"]

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=20&token=t"
                ) as ws_b:
                    ws_b.receive_text()  # presence count=2
                    ws_b.receive_text()  # document_state
                    ws_b.receive_text()  # self
                    ws_a.receive_text()  # presence count=2 rebroadcast to A

                    # A sends a selection_changed frame.
                    ws_a.send_text(
                        json.dumps(
                            {
                                "type": "selection_changed",
                                "flow_id": 20,
                                "node_ids": [1, 2, 3],
                            }
                        )
                    )

                    msg_a = json.loads(ws_a.receive_text())
                    msg_b = json.loads(ws_b.receive_text())

                    for msg in (msg_a, msg_b):
                        assert msg["type"] == "selection_changed"
                        assert msg["flow_id"] == 20
                        assert msg["node_ids"] == [1, 2, 3]
                        assert msg["origin"] == member_id_a
                        assert msg["user_id"] == 7

    def test_selection_empty_node_ids_relays(self):
        """An empty node_ids list is valid and must relay correctly."""
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=21&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state
                ws.receive_text()  # self

                ws.send_text(
                    json.dumps(
                        {"type": "selection_changed", "flow_id": 21, "node_ids": []}
                    )
                )
                msg = json.loads(ws.receive_text())
                assert msg["type"] == "selection_changed"
                assert msg["node_ids"] == []


# ---------------------------------------------------------------------------
# LC4 – cursor/selection do NOT write Redis keys
# ---------------------------------------------------------------------------


class TestNoRedisWrite:
    """cursor_moved and selection_changed must be purely ephemeral — no Redis writes."""

    def test_cursor_moved_writes_no_redis_key(self):
        fake_client = _make_fake_redis_client()
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services(fake_client)
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=30&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state
                ws.receive_text()  # self

                # Capture all existing keys after join (presence SET was written).
                keys_after_join = set(asyncio.run(fake_client.keys("*")))

                ws.send_text(
                    json.dumps(
                        {"type": "cursor_moved", "flow_id": 30, "x": 1.0, "y": 2.0}
                    )
                )
                ws.receive_text()  # consume the relay broadcast

                # Check inside the context manager — before leave() removes the presence key.
                keys_after_cursor = set(asyncio.run(fake_client.keys("*")))
                assert keys_after_cursor == keys_after_join

    def test_selection_changed_writes_no_redis_key(self):
        fake_client = _make_fake_redis_client()
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services(fake_client)
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=31&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state
                ws.receive_text()  # self

                keys_after_join = set(asyncio.run(fake_client.keys("*")))

                ws.send_text(
                    json.dumps(
                        {
                            "type": "selection_changed",
                            "flow_id": 31,
                            "node_ids": [5, 6],
                        }
                    )
                )
                ws.receive_text()  # consume relay broadcast

                # Check inside the context manager — before leave() removes the presence key.
                keys_after_selection = set(asyncio.run(fake_client.keys("*")))
                assert keys_after_selection == keys_after_join


# ---------------------------------------------------------------------------
# LC5 – flow isolation for cursor events
# ---------------------------------------------------------------------------


class TestCursorFlowIsolation:
    """cursor_moved on flow A must NOT appear on flow B's sockets."""

    def test_cursor_moved_on_flow_1_not_seen_by_flow_2(self):
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=60&token=t"
            ) as ws_60:
                ws_60.receive_text()  # presence
                ws_60.receive_text()  # document_state
                ws_60.receive_text()  # self

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=61&token=t"
                ) as ws_61:
                    ws_61.receive_text()  # presence
                    ws_61.receive_text()  # document_state
                    ws_61.receive_text()  # self

                    # ws_60 sends cursor_moved on flow 60.
                    ws_60.send_text(
                        json.dumps(
                            {"type": "cursor_moved", "flow_id": 60, "x": 1.0, "y": 2.0}
                        )
                    )

                    # ws_60 must receive its own broadcast.
                    msg_60 = json.loads(ws_60.receive_text())
                    assert msg_60["type"] == "cursor_moved"
                    assert msg_60["flow_id"] == 60

                    # ws_61 must NOT have received the cursor event — send a
                    # selection ping on flow 61 and confirm the next message is that.
                    ws_61.send_text(
                        json.dumps(
                            {
                                "type": "selection_changed",
                                "flow_id": 61,
                                "node_ids": [],
                            }
                        )
                    )
                    msg_61 = json.loads(ws_61.receive_text())
                    assert (
                        msg_61["flow_id"] == 61
                    ), "flow 61 received a message intended for flow 60"


# ---------------------------------------------------------------------------
# LC6 – malformed cursor frame ignored, socket stays alive
# ---------------------------------------------------------------------------


class TestMalformedCursorIgnored:
    """A malformed cursor_moved must not close the socket."""

    def test_malformed_cursor_frame_ignored_socket_alive(self):
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=70&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state
                ws.receive_text()  # self

                # cursor_moved missing required fields (extra="forbid" + missing x/y).
                ws.send_text(json.dumps({"type": "cursor_moved", "flow_id": 70}))

                # Socket must still be alive — send a valid cursor afterwards.
                ws.send_text(
                    json.dumps(
                        {"type": "cursor_moved", "flow_id": 70, "x": 5.0, "y": 6.0}
                    )
                )
                msg = json.loads(ws.receive_text())
                assert msg["type"] == "cursor_moved"
                assert msg["x"] == 5.0

    def test_malformed_json_before_cursor_ignored(self):
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=71&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state
                ws.receive_text()  # self

                ws.send_text("{not valid json at all")

                # Socket still alive.
                ws.send_text(
                    json.dumps(
                        {"type": "cursor_moved", "flow_id": 71, "x": 0.0, "y": 0.0}
                    )
                )
                msg = json.loads(ws.receive_text())
                assert msg["type"] == "cursor_moved"


# ---------------------------------------------------------------------------
# LC7 – active token without user_id → close 1008
# ---------------------------------------------------------------------------


class TestActiveTokenWithoutUserId:
    """A token that passes introspection but carries no user_id must be rejected."""

    def test_active_token_without_user_id_closes_1008(self):
        presence_svc, live_doc_svc, cursor_svc, _, _ = _make_services()

        def _no_user_id_introspect(token: str) -> dict | None:
            # Token is active but missing user_id — not a usable identity.
            return {"active": True}

        app = _build_app(presence_svc, live_doc_svc, cursor_svc, _no_user_id_introspect)

        with TestClient(app) as client:
            with pytest.raises(Exception):
                with client.websocket_connect(
                    "/realtime/collab/?flow_id=1&token=active-no-uid"
                ) as ws:
                    ws.receive_text()
