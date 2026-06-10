"""Integration tests for the live-document (node-move) WebSocket feature.

Covers:
  LD1 – join receives document_state (empty case)
  LD2 – join receives document_state (pre-populated case)
  LD3 – client A's node_moved reaches A and B with correct origin
  LD4 – HSET happened (fake Redis hash holds the JSON)
  LD5 – malformed frame is ignored without disconnect
  LD6 – moves on flow 1 don't reach flow 2's sockets

All EST-2 presence tests remain intact in test_collab_presence.py.
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
from application.live_document_service import LiveDocumentService
from application.presence_service import PresenceService
from domain.models.collab_messages import NodeMovedIn
from infrastructure.persistence.live_document_repository import LiveDocumentRepository
from infrastructure.persistence.presence_repository import PresenceRepository


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_fake_redis_client() -> fake_aioredis.FakeRedis:
    # decode_responses=True mirrors the real RedisService connection setting,
    # ensuring hgetall returns str keys/values rather than bytes.
    return fake_aioredis.FakeRedis(decode_responses=True)


def _make_services(
    fake_client: fake_aioredis.FakeRedis | None = None,
) -> tuple[
    PresenceService, LiveDocumentService, CollabSocketRegistry, LiveDocumentRepository
]:
    """Build a wired set of services backed by an in-process FakeRedis."""
    if fake_client is None:
        fake_client = _make_fake_redis_client()

    fake_redis_service = SimpleNamespace(aioredis_client=fake_client)

    presence_repo = PresenceRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    live_doc_repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]
    registry = CollabSocketRegistry()
    presence_svc = PresenceService(repository=presence_repo, registry=registry)
    live_doc_svc = LiveDocumentService(registry=registry, repository=live_doc_repo)

    return presence_svc, live_doc_svc, registry, live_doc_repo


def _build_app(
    presence_service: PresenceService,
    live_document_service: LiveDocumentService,
    introspect_fn: Callable[[str], dict | None],
) -> FastAPI:
    """Minimal FastAPI app mirroring the production collab route."""
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

        if flow_id is None:
            await websocket.close(code=1008)
            return

        await websocket.accept()
        member_id: str | None = None
        try:
            member_id = await presence_service.join(flow_id, websocket, user_id=1)

            # Send document state snapshot to the joining socket.
            doc_state = await live_document_service.get_document_state(flow_id)
            await websocket.send_json(doc_state)

            while True:
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                    if data.get("type") == "node_moved":
                        frame = NodeMovedIn(**data)
                        await live_document_service.apply_node_move(
                            flow_id=frame.flow_id,
                            node_id=frame.node_id,
                            x=frame.x,
                            y=frame.y,
                            origin_member_id=member_id,
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


_VALID_USER = {"active": True, "user_id": 1, "username": "test"}


def _valid_introspect(token: str) -> dict | None:
    return _VALID_USER


# ---------------------------------------------------------------------------
# LD1 – join receives document_state (empty)
# ---------------------------------------------------------------------------


class TestDocumentStateEmpty:
    """On join with no prior moves the client receives positions: {}."""

    def test_join_receives_empty_document_state(self):
        presence_svc, live_doc_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=1&token=t") as ws:
                # First message: presence broadcast.
                presence_msg = json.loads(ws.receive_text())
                assert presence_msg["type"] == "presence"

                # Second message: document_state.
                doc_state = json.loads(ws.receive_text())
                # Phase 1 (EST-6): document_state now includes schema_version,
                # nodes, connections, and tombstones in addition to positions.
                assert doc_state["type"] == "document_state"
                assert doc_state["flow_id"] == 1
                assert doc_state["schema_version"] == 2
                assert doc_state["positions"] == {}
                assert doc_state["nodes"] == {}
                assert doc_state["connections"] == {}
                assert doc_state["tombstones"] == {}


# ---------------------------------------------------------------------------
# LD2 – join receives document_state (pre-populated)
# ---------------------------------------------------------------------------


class TestDocumentStatePrePopulated:
    """On join when moves already exist the client receives the current snapshot."""

    def test_join_receives_pre_populated_document_state(self):
        fake_client = _make_fake_redis_client()
        presence_svc, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        # Pre-populate two node positions directly via the repository.
        asyncio.run(live_doc_repo.set_position(flow_id=5, node_id=10, x=100.0, y=200.0))
        asyncio.run(live_doc_repo.set_position(flow_id=5, node_id=20, x=300.0, y=400.0))

        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=5&token=t") as ws:
                # Consume presence broadcast.
                ws.receive_text()

                doc_state = json.loads(ws.receive_text())
                assert doc_state["type"] == "document_state"
                assert doc_state["flow_id"] == 5
                positions = doc_state["positions"]
                assert positions["10"] == {"x": 100.0, "y": 200.0}
                assert positions["20"] == {"x": 300.0, "y": 400.0}


# ---------------------------------------------------------------------------
# LD3 – node_moved reaches BOTH sender and peer with correct origin
# ---------------------------------------------------------------------------


class TestNodeMovedBroadcast:
    """A node_moved from client A must reach A and B, with origin = A's member_id."""

    def test_node_moved_reaches_sender_and_peer_with_origin(self):
        presence_svc, live_doc_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=7&token=t"
            ) as ws_a:
                # Consume ws_a presence (count=1) + document_state.
                ws_a.receive_text()
                ws_a.receive_text()

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=7&token=t"
                ) as ws_b:
                    # Consume ws_b presence (count=2) and ws_a's update (count=2).
                    ws_b.receive_text()  # presence count=2 on ws_b
                    ws_b.receive_text()  # document_state on ws_b
                    ws_a.receive_text()  # presence count=2 on ws_a

                    # ws_a sends a node_moved frame.
                    move_frame = json.dumps(
                        {
                            "type": "node_moved",
                            "flow_id": 7,
                            "node_id": 42,
                            "x": 50.5,
                            "y": 75.0,
                        }
                    )
                    ws_a.send_text(move_frame)

                    # Both ws_a and ws_b should receive the rebroadcast.
                    msg_a = json.loads(ws_a.receive_text())
                    msg_b = json.loads(ws_b.receive_text())

                    # Both must have the same shape.
                    for msg in (msg_a, msg_b):
                        assert msg["type"] == "node_moved"
                        assert msg["flow_id"] == 7
                        assert msg["node_id"] == 42
                        assert msg["x"] == 50.5
                        assert msg["y"] == 75.0
                        assert "origin" in msg

                    # Both must carry the same origin (ws_a's member_id).
                    assert msg_a["origin"] == msg_b["origin"]
                    # Origin must not be empty.
                    assert msg_a["origin"] != ""


# ---------------------------------------------------------------------------
# LD4 – HSET happened (fake Redis hash holds the JSON)
# ---------------------------------------------------------------------------


class TestHsetPersisted:
    """After a node_moved, the Redis hash must contain the serialised position."""

    def test_hset_persists_position_in_redis(self):
        fake_client = _make_fake_redis_client()
        presence_svc, live_doc_svc, _, live_doc_repo = _make_services(fake_client)
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=9&token=t") as ws:
                # Consume presence + document_state.
                ws.receive_text()
                ws.receive_text()

                ws.send_text(
                    json.dumps(
                        {
                            "type": "node_moved",
                            "flow_id": 9,
                            "node_id": 99,
                            "x": 11.0,
                            "y": 22.0,
                        }
                    )
                )
                # Consume the rebroadcast so the send has been processed.
                ws.receive_text()

        # Verify the Redis hash directly via the repository.
        positions = asyncio.run(live_doc_repo.get_all_positions(flow_id=9))
        assert "99" in positions
        assert positions["99"] == {"x": 11.0, "y": 22.0}


# ---------------------------------------------------------------------------
# LD5 – malformed frame is ignored without disconnect
# ---------------------------------------------------------------------------


class TestMalformedFrameIgnored:
    """A malformed or unknown-type frame must not disconnect the socket."""

    def test_malformed_json_is_ignored(self):
        presence_svc, live_doc_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=11&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state

                # Send malformed JSON — must not close the socket.
                ws.send_text("{not valid json")

                # Send a valid move afterwards to confirm socket is still alive.
                ws.send_text(
                    json.dumps(
                        {
                            "type": "node_moved",
                            "flow_id": 11,
                            "node_id": 1,
                            "x": 0.0,
                            "y": 0.0,
                        }
                    )
                )
                msg = json.loads(ws.receive_text())
                assert msg["type"] == "node_moved"

    def test_unknown_type_is_ignored(self):
        presence_svc, live_doc_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=12&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state

                # Completely unknown type must be silently ignored.
                ws.send_text(json.dumps({"type": "bogus_type", "x": 1, "y": 2}))

                # Socket still alive — send a valid move.
                ws.send_text(
                    json.dumps(
                        {
                            "type": "node_moved",
                            "flow_id": 12,
                            "node_id": 2,
                            "x": 5.0,
                            "y": 6.0,
                        }
                    )
                )
                msg = json.loads(ws.receive_text())
                assert msg["type"] == "node_moved"

    def test_missing_required_field_is_ignored(self):
        presence_svc, live_doc_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect("/realtime/collab/?flow_id=13&token=t") as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state

                # node_moved missing required 'y' field.
                ws.send_text(
                    json.dumps(
                        {"type": "node_moved", "flow_id": 13, "node_id": 5, "x": 1.0}
                    )
                )

                # Socket still alive.
                ws.send_text(
                    json.dumps(
                        {
                            "type": "node_moved",
                            "flow_id": 13,
                            "node_id": 5,
                            "x": 1.0,
                            "y": 2.0,
                        }
                    )
                )
                msg = json.loads(ws.receive_text())
                assert msg["type"] == "node_moved"


# ---------------------------------------------------------------------------
# LD6 – moves on flow 1 don't reach flow 2's sockets
# ---------------------------------------------------------------------------


class TestFlowIsolation:
    """node_moved on flow A must NOT appear on flow B's sockets."""

    def test_move_on_flow_1_not_seen_by_flow_2(self):
        presence_svc, live_doc_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=50&token=t"
            ) as ws_flow_50:
                ws_flow_50.receive_text()  # presence
                ws_flow_50.receive_text()  # document_state

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=51&token=t"
                ) as ws_flow_51:
                    ws_flow_51.receive_text()  # presence
                    ws_flow_51.receive_text()  # document_state

                    # ws_flow_50 sends a node_moved on flow 50.
                    ws_flow_50.send_text(
                        json.dumps(
                            {
                                "type": "node_moved",
                                "flow_id": 50,
                                "node_id": 7,
                                "x": 10.0,
                                "y": 20.0,
                            }
                        )
                    )

                    # ws_flow_50 receives its own rebroadcast.
                    msg_50 = json.loads(ws_flow_50.receive_text())
                    assert msg_50["type"] == "node_moved"
                    assert msg_50["flow_id"] == 50

                    # ws_flow_51 must NOT have received anything — it's on a different flow.
                    # Send a ping on flow 51 and assert the next message is that ping's echo,
                    # not the move from flow 50.
                    ws_flow_51.send_text(
                        json.dumps(
                            {
                                "type": "node_moved",
                                "flow_id": 51,
                                "node_id": 99,
                                "x": 0.0,
                                "y": 0.0,
                            }
                        )
                    )
                    msg_51 = json.loads(ws_flow_51.receive_text())
                    assert (
                        msg_51["flow_id"] == 51
                    ), "flow 51 received a message intended for flow 50"
