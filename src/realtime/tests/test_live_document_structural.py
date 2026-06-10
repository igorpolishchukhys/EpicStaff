"""Integration tests for Phase 1 structural sync (EST-6).

Covers:
  AC1 – add-node persists and broadcasts to all room sockets
  AC2 – delete-node cascades connections server-side; broadcast carries removed_connection_ids
  AC3 – connection add/remove persist + broadcast
  AC4 – applying a node_deleted / connection op for an already-deleted key is a graceful no-op
  AC5 – get_document_state returns nodes + connections + tombstones + schema_version
  AC6 – idempotent re-apply (add-exists guard, delete-missing guard)
  AC7 – per-flow isolation (ops on flow A do not leak to flow B)

All tests use fakeredis.aioredis and the project's async conventions.
No real Redis, no real WebSocket server needed for service-layer tests.
WebSocket-layer tests reuse the minimal FastAPI app pattern from test_live_document.py.
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
from domain.models.collab_messages import (
    ConnectionAddedIn,
    ConnectionRemovedIn,
    NodeAddedIn,
    NodeDeletedIn,
)
from infrastructure.persistence.live_document_repository import LiveDocumentRepository
from infrastructure.persistence.presence_repository import PresenceRepository


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_fake_redis_client() -> fake_aioredis.FakeRedis:
    return fake_aioredis.FakeRedis(decode_responses=True)


def _make_services(
    fake_client: fake_aioredis.FakeRedis | None = None,
) -> tuple[
    PresenceService,
    LiveDocumentService,
    CollabSocketRegistry,
    LiveDocumentRepository,
]:
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
    """Minimal FastAPI app mirroring the production collab route (structural frames only)."""
    app = FastAPI()

    @app.websocket("/realtime/collab/")
    async def collab(
        websocket: WebSocket,
        flow_id: int | None = None,
        token: str | None = None,
    ):
        if not token or not introspect_fn(token) or flow_id is None:
            await websocket.close(code=1008)
            return

        await websocket.accept()
        member_id: str | None = None
        try:
            member_id = await presence_service.join(flow_id, websocket, user_id=1)

            doc_state = await live_document_service.get_document_state(flow_id)
            await websocket.send_json(doc_state)

            while True:
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                    msg_type = data.get("type")
                    if msg_type == "node_added":
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
                await presence_service.leave(flow_id, websocket, member_id)

    return app


_VALID_USER = {"active": True, "user_id": 1, "username": "test"}


def _valid_introspect(token: str) -> dict | None:
    return _VALID_USER


# ---------------------------------------------------------------------------
# Repository-level unit tests (async, service-layer, no HTTP)
# ---------------------------------------------------------------------------


class TestRepositoryNodes:
    """Direct repository operations for node storage."""

    def test_add_and_get_node(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        node = {"id": "abc-123", "type": "agent", "x": 10, "y": 20}
        asyncio.run(repo.add_node(flow_id=1, node_key="abc-123", node=node))

        nodes = asyncio.run(repo.get_all_nodes(flow_id=1))
        assert "abc-123" in nodes
        assert nodes["abc-123"] == node

    def test_node_exists_true_and_false(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        asyncio.run(repo.add_node(flow_id=2, node_key="node-x", node={"type": "code"}))
        assert asyncio.run(repo.node_exists(flow_id=2, node_key="node-x")) is True
        assert asyncio.run(repo.node_exists(flow_id=2, node_key="node-y")) is False

    def test_remove_node(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        asyncio.run(repo.add_node(flow_id=3, node_key="del-me", node={"type": "x"}))
        asyncio.run(repo.remove_node(flow_id=3, node_key="del-me"))

        assert asyncio.run(repo.node_exists(flow_id=3, node_key="del-me")) is False

    def test_remove_node_missing_is_noop(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        # Should not raise
        asyncio.run(repo.remove_node(flow_id=4, node_key="never-existed"))


class TestRepositoryConnections:
    """Direct repository operations for connection storage."""

    def test_add_and_get_connection(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        asyncio.run(
            repo.add_connection(
                flow_id=10,
                connection_id="conn-1",
                source_node_key="node-a",
                target_node_key="node-b",
                source_port_id="out",
                target_port_id="in",
                connection={"label": "edge"},
            )
        )

        conns = asyncio.run(repo.get_all_connections(flow_id=10))
        assert "conn-1" in conns
        record = conns["conn-1"]
        assert record["source_node_key"] == "node-a"
        assert record["target_node_key"] == "node-b"
        assert record["source_port_id"] == "out"
        assert record["target_port_id"] == "in"
        assert record["connection"] == {"label": "edge"}

    def test_get_connections_for_node(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        # node-a → node-b, node-b → node-c
        asyncio.run(
            repo.add_connection(
                flow_id=11,
                connection_id="conn-ab",
                source_node_key="node-a",
                target_node_key="node-b",
                source_port_id="out",
                target_port_id="in",
                connection={},
            )
        )
        asyncio.run(
            repo.add_connection(
                flow_id=11,
                connection_id="conn-bc",
                source_node_key="node-b",
                target_node_key="node-c",
                source_port_id="out",
                target_port_id="in",
                connection={},
            )
        )
        asyncio.run(
            repo.add_connection(
                flow_id=11,
                connection_id="conn-ac",
                source_node_key="node-a",
                target_node_key="node-c",
                source_port_id="out2",
                target_port_id="in2",
                connection={},
            )
        )

        # node-b is source of conn-bc and target of conn-ab
        orphaned = asyncio.run(
            repo.get_connections_for_node(flow_id=11, node_key="node-b")
        )
        assert set(orphaned) == {"conn-ab", "conn-bc"}

    def test_remove_connection_missing_is_noop(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        asyncio.run(repo.remove_connection(flow_id=12, connection_id="ghost"))


class TestRepositoryTombstones:
    """Direct repository operations for tombstone storage."""

    def test_add_node_and_connection_tombstones(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        asyncio.run(repo.add_node_tombstone(flow_id=20, node_key="nk-1"))
        asyncio.run(repo.add_connection_tombstone(flow_id=20, connection_id="conn-1"))

        tombstones = asyncio.run(repo.get_tombstones(flow_id=20))
        assert "node:nk-1" in tombstones
        assert "conn:conn-1" in tombstones
        assert tombstones["node:nk-1"] == "1"
        assert tombstones["conn:conn-1"] == "1"

    def test_tombstones_empty_when_none_added(self):
        fake_client = _make_fake_redis_client()
        fake_redis_service = SimpleNamespace(aioredis_client=fake_client)
        repo = LiveDocumentRepository(redis_service=fake_redis_service)  # type: ignore[arg-type]

        tombstones = asyncio.run(repo.get_tombstones(flow_id=99))
        assert tombstones == {}


# ---------------------------------------------------------------------------
# AC5 – get_document_state returns nodes + connections + tombstones + schema_version
# ---------------------------------------------------------------------------


class TestDocumentStateShape:
    """get_document_state returns the full structural snapshot with schema_version."""

    def test_empty_state_has_all_keys_and_schema_version(self):
        _, live_doc_svc, _, _ = _make_services()
        state = asyncio.run(live_doc_svc.get_document_state(flow_id=100))

        assert state["type"] == "document_state"
        assert state["flow_id"] == 100
        assert state["schema_version"] == 2
        assert state["positions"] == {}
        assert state["nodes"] == {}
        assert state["connections"] == {}
        assert state["tombstones"] == {}

    def test_populated_state_contains_all_data(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(
            live_doc_repo.add_node(flow_id=101, node_key="nk-1", node={"type": "agent"})
        )
        asyncio.run(
            live_doc_repo.add_connection(
                flow_id=101,
                connection_id="conn-1",
                source_node_key="nk-1",
                target_node_key="nk-2",
                source_port_id="out",
                target_port_id="in",
                connection={"weight": 1},
            )
        )
        asyncio.run(live_doc_repo.add_node_tombstone(flow_id=101, node_key="old-nk"))

        state = asyncio.run(live_doc_svc.get_document_state(flow_id=101))

        assert state["schema_version"] == 2
        assert "nk-1" in state["nodes"]
        assert "conn-1" in state["connections"]
        assert "node:old-nk" in state["tombstones"]


# ---------------------------------------------------------------------------
# Service-layer tests (no WebSocket)
# ---------------------------------------------------------------------------


class TestApplyNodeAdded:
    """apply_node_added persists and marks existence; add-exists guard is idempotent."""

    def test_persist_new_node(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(
            live_doc_svc.apply_node_added(
                flow_id=200,
                node_key="nk-new",
                node={"type": "code"},
                origin_member_id="m-1",
            )
        )

        assert asyncio.run(live_doc_repo.node_exists(flow_id=200, node_key="nk-new"))
        nodes = asyncio.run(live_doc_repo.get_all_nodes(flow_id=200))
        assert nodes["nk-new"] == {"type": "code"}

    def test_add_exists_guard_is_noop(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(
            live_doc_svc.apply_node_added(
                flow_id=201,
                node_key="nk-dup",
                node={"type": "a"},
                origin_member_id="m-1",
            )
        )
        # Second call with different payload — should be ignored (first wins).
        asyncio.run(
            live_doc_svc.apply_node_added(
                flow_id=201,
                node_key="nk-dup",
                node={"type": "b"},
                origin_member_id="m-2",
            )
        )

        nodes = asyncio.run(live_doc_repo.get_all_nodes(flow_id=201))
        # Original payload preserved.
        assert nodes["nk-dup"] == {"type": "a"}


class TestApplyNodeDeleted:
    """apply_node_deleted cascades connections and writes tombstones."""

    def test_delete_node_removes_it_and_leaves_tombstone(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=300, node_key="nk-x", node={}))
        asyncio.run(
            live_doc_svc.apply_node_deleted(
                flow_id=300, node_key="nk-x", origin_member_id="m-1"
            )
        )

        assert not asyncio.run(live_doc_repo.node_exists(flow_id=300, node_key="nk-x"))
        tombstones = asyncio.run(live_doc_repo.get_tombstones(flow_id=300))
        assert "node:nk-x" in tombstones

    def test_delete_cascades_connections(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=301, node_key="nk-a", node={}))
        asyncio.run(live_doc_repo.add_node(flow_id=301, node_key="nk-b", node={}))
        asyncio.run(
            live_doc_repo.add_connection(
                flow_id=301,
                connection_id="conn-ab",
                source_node_key="nk-a",
                target_node_key="nk-b",
                source_port_id="out",
                target_port_id="in",
                connection={},
            )
        )

        asyncio.run(
            live_doc_svc.apply_node_deleted(
                flow_id=301, node_key="nk-a", origin_member_id="m-1"
            )
        )

        conns = asyncio.run(live_doc_repo.get_all_connections(flow_id=301))
        assert "conn-ab" not in conns
        tombstones = asyncio.run(live_doc_repo.get_tombstones(flow_id=301))
        assert "conn:conn-ab" in tombstones

    def test_delete_missing_node_is_noop(self):
        _, live_doc_svc, _, _ = _make_services()

        # Must not raise
        asyncio.run(
            live_doc_svc.apply_node_deleted(
                flow_id=302, node_key="ghost", origin_member_id="m-1"
            )
        )


class TestApplyConnectionAdded:
    """apply_connection_added persists when both endpoints exist; drops when either is missing."""

    def test_add_connection_with_both_nodes_present(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=400, node_key="src", node={}))
        asyncio.run(live_doc_repo.add_node(flow_id=400, node_key="tgt", node={}))

        asyncio.run(
            live_doc_svc.apply_connection_added(
                flow_id=400,
                connection_id="conn-st",
                source_node_key="src",
                target_node_key="tgt",
                source_port_id="out",
                target_port_id="in",
                connection={"label": "x"},
                origin_member_id="m-1",
            )
        )

        conns = asyncio.run(live_doc_repo.get_all_connections(flow_id=400))
        assert "conn-st" in conns

    def test_connection_dropped_when_source_node_missing(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=401, node_key="tgt-only", node={}))

        asyncio.run(
            live_doc_svc.apply_connection_added(
                flow_id=401,
                connection_id="conn-orphan",
                source_node_key="missing-src",
                target_node_key="tgt-only",
                source_port_id="out",
                target_port_id="in",
                connection={},
                origin_member_id="m-1",
            )
        )

        conns = asyncio.run(live_doc_repo.get_all_connections(flow_id=401))
        assert "conn-orphan" not in conns

    def test_connection_dropped_when_target_node_missing(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=402, node_key="src-only", node={}))

        asyncio.run(
            live_doc_svc.apply_connection_added(
                flow_id=402,
                connection_id="conn-orphan",
                source_node_key="src-only",
                target_node_key="missing-tgt",
                source_port_id="out",
                target_port_id="in",
                connection={},
                origin_member_id="m-1",
            )
        )

        conns = asyncio.run(live_doc_repo.get_all_connections(flow_id=402))
        assert "conn-orphan" not in conns


class TestTombstoneClearedOnReAdd:
    """Re-adding a previously tombstoned key must clear the tombstone entry."""

    def test_re_add_node_clears_its_tombstone(self):
        """save → delete → re-add: tombstone must be gone after re-add."""
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        # Add, then delete (writes tombstone).
        asyncio.run(
            live_doc_svc.apply_node_added(
                flow_id=5000,
                node_key="nk-cycle",
                node={"type": "agent"},
                origin_member_id="m-1",
            )
        )
        asyncio.run(
            live_doc_svc.apply_node_deleted(
                flow_id=5000, node_key="nk-cycle", origin_member_id="m-1"
            )
        )
        tombstones_after_delete = asyncio.run(
            live_doc_repo.get_tombstones(flow_id=5000)
        )
        assert "node:nk-cycle" in tombstones_after_delete

        # Re-add the same node_key.
        asyncio.run(
            live_doc_svc.apply_node_added(
                flow_id=5000,
                node_key="nk-cycle",
                node={"type": "agent"},
                origin_member_id="m-1",
            )
        )

        tombstones_after_readd = asyncio.run(live_doc_repo.get_tombstones(flow_id=5000))
        assert (
            "node:nk-cycle" not in tombstones_after_readd
        ), "stale tombstone should have been cleared when node was re-added"
        assert asyncio.run(live_doc_repo.node_exists(flow_id=5000, node_key="nk-cycle"))

    def test_re_add_connection_clears_its_tombstone(self):
        """add → remove → re-add connection: tombstone must be gone after re-add."""
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=5001, node_key="src", node={}))
        asyncio.run(live_doc_repo.add_node(flow_id=5001, node_key="tgt", node={}))

        # Add, then remove (writes tombstone).
        asyncio.run(
            live_doc_svc.apply_connection_added(
                flow_id=5001,
                connection_id="conn-cycle",
                source_node_key="src",
                target_node_key="tgt",
                source_port_id="out",
                target_port_id="in",
                connection={},
                origin_member_id="m-1",
            )
        )
        asyncio.run(
            live_doc_svc.apply_connection_removed(
                flow_id=5001, connection_id="conn-cycle", origin_member_id="m-1"
            )
        )
        tombstones_after_remove = asyncio.run(
            live_doc_repo.get_tombstones(flow_id=5001)
        )
        assert "conn:conn-cycle" in tombstones_after_remove

        # Re-add the same connection_id.
        asyncio.run(
            live_doc_svc.apply_connection_added(
                flow_id=5001,
                connection_id="conn-cycle",
                source_node_key="src",
                target_node_key="tgt",
                source_port_id="out",
                target_port_id="in",
                connection={},
                origin_member_id="m-1",
            )
        )

        tombstones_after_readd = asyncio.run(live_doc_repo.get_tombstones(flow_id=5001))
        assert (
            "conn:conn-cycle" not in tombstones_after_readd
        ), "stale tombstone should have been cleared when connection was re-added"
        assert asyncio.run(
            live_doc_repo.connection_exists(flow_id=5001, connection_id="conn-cycle")
        )


class TestConnectionAddIdempotency:
    """Duplicate connection_id is a silent no-op (first write wins)."""

    def test_duplicate_connection_id_is_noop(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=5100, node_key="src", node={}))
        asyncio.run(live_doc_repo.add_node(flow_id=5100, node_key="tgt", node={}))

        asyncio.run(
            live_doc_svc.apply_connection_added(
                flow_id=5100,
                connection_id="conn-idem",
                source_node_key="src",
                target_node_key="tgt",
                source_port_id="out",
                target_port_id="in",
                connection={"label": "first"},
                origin_member_id="m-1",
            )
        )
        # Second call with same connection_id but different payload — must be ignored.
        asyncio.run(
            live_doc_svc.apply_connection_added(
                flow_id=5100,
                connection_id="conn-idem",
                source_node_key="src",
                target_node_key="tgt",
                source_port_id="out",
                target_port_id="in",
                connection={"label": "second"},
                origin_member_id="m-2",
            )
        )

        conns = asyncio.run(live_doc_repo.get_all_connections(flow_id=5100))
        # First payload is preserved; second is discarded.
        assert conns["conn-idem"]["connection"] == {
            "label": "first"
        }, "duplicate connection_id should be a no-op; first write must win"


class TestApplyConnectionRemoved:
    """apply_connection_removed writes tombstone; missing connection is no-op."""

    def test_remove_existing_connection(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(
            live_doc_repo.add_connection(
                flow_id=500,
                connection_id="conn-z",
                source_node_key="s",
                target_node_key="t",
                source_port_id="p1",
                target_port_id="p2",
                connection={},
            )
        )

        asyncio.run(
            live_doc_svc.apply_connection_removed(
                flow_id=500, connection_id="conn-z", origin_member_id="m-1"
            )
        )

        conns = asyncio.run(live_doc_repo.get_all_connections(flow_id=500))
        assert "conn-z" not in conns
        tombstones = asyncio.run(live_doc_repo.get_tombstones(flow_id=500))
        assert "conn:conn-z" in tombstones

    def test_remove_missing_connection_is_noop(self):
        _, live_doc_svc, _, _ = _make_services()

        # Must not raise
        asyncio.run(
            live_doc_svc.apply_connection_removed(
                flow_id=501, connection_id="ghost-conn", origin_member_id="m-1"
            )
        )


# ---------------------------------------------------------------------------
# AC1 – add-node broadcasts to all room sockets
# ---------------------------------------------------------------------------


class TestNodeAddedBroadcast:
    """node_added broadcasts reach every socket connected to the flow."""

    def test_node_added_reaches_sender_and_peer(self):
        presence_svc, live_doc_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=600&token=t"
            ) as ws_a:
                ws_a.receive_text()  # presence
                ws_a.receive_text()  # document_state

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=600&token=t"
                ) as ws_b:
                    ws_b.receive_text()  # presence
                    ws_b.receive_text()  # document_state
                    ws_a.receive_text()  # presence update on ws_a

                    ws_a.send_text(
                        json.dumps(
                            {
                                "type": "node_added",
                                "flow_id": 600,
                                "node_key": "nk-fresh",
                                "node": {"type": "agent", "label": "My Agent"},
                            }
                        )
                    )

                    msg_a = json.loads(ws_a.receive_text())
                    msg_b = json.loads(ws_b.receive_text())

                    for msg in (msg_a, msg_b):
                        assert msg["type"] == "node_added"
                        assert msg["flow_id"] == 600
                        assert msg["node_key"] == "nk-fresh"
                        assert msg["node"] == {"type": "agent", "label": "My Agent"}
                        assert "origin" in msg

                    assert msg_a["origin"] == msg_b["origin"]
                    assert msg_a["origin"] != ""


# ---------------------------------------------------------------------------
# AC2 – delete-node cascade: broadcast carries removed_connection_ids
# ---------------------------------------------------------------------------


class TestNodeDeletedCascade:
    """node_deleted broadcast carries removed_connection_ids computed server-side."""

    def test_delete_node_broadcasts_cascaded_connection_ids(self):
        fake_client = _make_fake_redis_client()
        presence_svc, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        # Pre-populate: two nodes and a connection between them.
        asyncio.run(live_doc_repo.add_node(flow_id=700, node_key="nk-del", node={}))
        asyncio.run(live_doc_repo.add_node(flow_id=700, node_key="nk-keep", node={}))
        asyncio.run(
            live_doc_repo.add_connection(
                flow_id=700,
                connection_id="conn-del-keep",
                source_node_key="nk-del",
                target_node_key="nk-keep",
                source_port_id="out",
                target_port_id="in",
                connection={},
            )
        )

        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=700&token=t"
            ) as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state

                ws.send_text(
                    json.dumps(
                        {
                            "type": "node_deleted",
                            "flow_id": 700,
                            "node_key": "nk-del",
                        }
                    )
                )

                msg = json.loads(ws.receive_text())

        assert msg["type"] == "node_deleted"
        assert msg["node_key"] == "nk-del"
        assert "conn-del-keep" in msg["removed_connection_ids"]
        # Verify cascade persisted.
        conns = asyncio.run(live_doc_repo.get_all_connections(flow_id=700))
        assert "conn-del-keep" not in conns


# ---------------------------------------------------------------------------
# AC3 – connection add/remove persist + broadcast
# ---------------------------------------------------------------------------


class TestConnectionAddedBroadcast:
    """connection_added broadcasts to all room sockets when both endpoint nodes exist."""

    def test_connection_added_reaches_sender(self):
        fake_client = _make_fake_redis_client()
        presence_svc, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=800, node_key="src", node={}))
        asyncio.run(live_doc_repo.add_node(flow_id=800, node_key="tgt", node={}))

        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=800&token=t"
            ) as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state

                ws.send_text(
                    json.dumps(
                        {
                            "type": "connection_added",
                            "flow_id": 800,
                            "connection_id": "conn-new",
                            "source_node_key": "src",
                            "target_node_key": "tgt",
                            "source_port_id": "out",
                            "target_port_id": "in",
                            "connection": {"weight": 2},
                        }
                    )
                )

                msg = json.loads(ws.receive_text())

        assert msg["type"] == "connection_added"
        assert msg["connection_id"] == "conn-new"
        assert msg["source_node_key"] == "src"
        assert msg["target_node_key"] == "tgt"
        assert msg["source_port_id"] == "out"
        assert msg["target_port_id"] == "in"
        assert msg["connection"] == {"weight": 2}
        assert "origin" in msg


class TestConnectionRemovedBroadcast:
    """connection_removed broadcasts to all room sockets."""

    def test_connection_removed_reaches_sender(self):
        fake_client = _make_fake_redis_client()
        presence_svc, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(
            live_doc_repo.add_connection(
                flow_id=900,
                connection_id="conn-bye",
                source_node_key="s",
                target_node_key="t",
                source_port_id="p",
                target_port_id="q",
                connection={},
            )
        )

        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=900&token=t"
            ) as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state

                ws.send_text(
                    json.dumps(
                        {
                            "type": "connection_removed",
                            "flow_id": 900,
                            "connection_id": "conn-bye",
                        }
                    )
                )

                msg = json.loads(ws.receive_text())

        assert msg["type"] == "connection_removed"
        assert msg["connection_id"] == "conn-bye"
        assert "origin" in msg


# ---------------------------------------------------------------------------
# AC4 – graceful no-op for double-delete and missing-connection-remove
# ---------------------------------------------------------------------------


class TestIdempotentDeletes:
    """Double-deleting a node or removing an absent connection must not raise or crash."""

    def test_node_deleted_twice_is_noop_second_time(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(live_doc_repo.add_node(flow_id=1000, node_key="nk-once", node={}))
        asyncio.run(
            live_doc_svc.apply_node_deleted(
                flow_id=1000, node_key="nk-once", origin_member_id="m-1"
            )
        )
        # Second delete — must be silent no-op.
        asyncio.run(
            live_doc_svc.apply_node_deleted(
                flow_id=1000, node_key="nk-once", origin_member_id="m-1"
            )
        )

    def test_connection_removed_twice_is_noop_second_time(self):
        fake_client = _make_fake_redis_client()
        _, live_doc_svc, _, live_doc_repo = _make_services(fake_client)

        asyncio.run(
            live_doc_repo.add_connection(
                flow_id=1001,
                connection_id="conn-once",
                source_node_key="s",
                target_node_key="t",
                source_port_id="p",
                target_port_id="q",
                connection={},
            )
        )
        asyncio.run(
            live_doc_svc.apply_connection_removed(
                flow_id=1001, connection_id="conn-once", origin_member_id="m-1"
            )
        )
        # Second remove — must be silent no-op.
        asyncio.run(
            live_doc_svc.apply_connection_removed(
                flow_id=1001, connection_id="conn-once", origin_member_id="m-1"
            )
        )


# ---------------------------------------------------------------------------
# AC6 – idempotent re-apply (add-exists guard already covered in TestApplyNodeAdded)
# ---------------------------------------------------------------------------


class TestIdempotentAdd:
    """Adding the same node twice: the second call is a no-op (payload unchanged)."""

    def test_add_node_idempotent_via_websocket(self):
        presence_svc, live_doc_svc, _, live_doc_repo = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=1100&token=t"
            ) as ws:
                ws.receive_text()  # presence
                ws.receive_text()  # document_state

                add_frame = json.dumps(
                    {
                        "type": "node_added",
                        "flow_id": 1100,
                        "node_key": "nk-idem",
                        "node": {"type": "a"},
                    }
                )
                # First add: broadcasts.
                ws.send_text(add_frame)
                msg1 = json.loads(ws.receive_text())
                assert msg1["type"] == "node_added"

                # Second add with same key: no broadcast (no-op) so there's
                # no new message on the socket.  We verify by sending a
                # different known frame and checking the next message is that
                # one, not a second node_added.
                ws.send_text(add_frame)

                # Send a sentinel we'll recognise.
                ws.send_text(
                    json.dumps(
                        {
                            "type": "node_added",
                            "flow_id": 1100,
                            "node_key": "nk-sentinel",
                            "node": {"type": "sentinel"},
                        }
                    )
                )
                next_msg = json.loads(ws.receive_text())
                # The next broadcast must be the sentinel, not a duplicate nk-idem.
                assert next_msg["node_key"] == "nk-sentinel"


# ---------------------------------------------------------------------------
# AC7 – per-flow isolation
# ---------------------------------------------------------------------------


class TestFlowIsolationStructural:
    """Structural ops on flow A must not appear on flow B's sockets."""

    def test_node_added_on_flow_a_not_seen_by_flow_b(self):
        presence_svc, live_doc_svc, _, _ = _make_services()
        app = _build_app(presence_svc, live_doc_svc, _valid_introspect)

        with TestClient(app) as client:
            with client.websocket_connect(
                "/realtime/collab/?flow_id=2000&token=t"
            ) as ws_a:
                ws_a.receive_text()  # presence
                ws_a.receive_text()  # document_state

                with client.websocket_connect(
                    "/realtime/collab/?flow_id=2001&token=t"
                ) as ws_b:
                    ws_b.receive_text()  # presence
                    ws_b.receive_text()  # document_state

                    # ws_a sends node_added on flow 2000.
                    ws_a.send_text(
                        json.dumps(
                            {
                                "type": "node_added",
                                "flow_id": 2000,
                                "node_key": "nk-a",
                                "node": {"type": "x"},
                            }
                        )
                    )
                    # ws_a gets its broadcast back.
                    msg_a = json.loads(ws_a.receive_text())
                    assert msg_a["type"] == "node_added"
                    assert msg_a["flow_id"] == 2000

                    # ws_b must not have received anything from flow 2000.
                    # Confirm by sending a sentinel on flow 2001 and checking
                    # it's the next message on ws_b.
                    ws_b.send_text(
                        json.dumps(
                            {
                                "type": "node_added",
                                "flow_id": 2001,
                                "node_key": "nk-b",
                                "node": {"type": "y"},
                            }
                        )
                    )
                    msg_b = json.loads(ws_b.receive_text())
                    assert (
                        msg_b["flow_id"] == 2001
                    ), "flow 2001 received a message intended for flow 2000"
