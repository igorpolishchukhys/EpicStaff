from pydantic import BaseModel, ConfigDict


class NodeMovedIn(BaseModel):
    """Inbound frame sent by a client when a node is moved.

    Frozen contract (FE built against these field names):
        {"type": "node_moved", "flow_id": <int>, "node_id": <int>, "x": <number>, "y": <number>}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    node_id: int
    x: float
    y: float


class LockRequestIn(BaseModel):
    """Inbound frame sent by a client to acquire an exclusive node-panel lock.

    Frozen contract (FE built against these field names):
        {"type": "lock_request", "flow_id": <int>, "node_id": <int>}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    node_id: int


class LockReleaseIn(BaseModel):
    """Inbound frame sent by a client to release its node-panel lock.

    Frozen contract (FE built against these field names):
        {"type": "lock_release", "flow_id": <int>, "node_id": <int>}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    node_id: int


class NodeDataUpdatedIn(BaseModel):
    """Inbound frame sent by the lock holder to relay node data changes.

    Frozen contract (FE built against these field names):
        {"type": "node_data_updated", "flow_id": <int>, "node_id": <int>,
         "node_name": "<str>", "data": {...}}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    node_id: int
    node_name: str
    data: dict


class HeartbeatIn(BaseModel):
    """Inbound keep-alive frame sent by a client every 10s (EST-9).

    Frozen contract (FE built against these field names):
        {"type": "heartbeat", "flow_id": <int>}

    Answered directly to the sender (not broadcast) with:
        {"type": "heartbeat_ack", "flow_id": <int>}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int


class CursorMovedIn(BaseModel):
    """Inbound frame sent by a client when the cursor moves on the canvas.

    Frozen contract (FE built against these field names):
        {"type": "cursor_moved", "flow_id": <int>, "x": <float>, "y": <float>}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    x: float
    y: float


class SelectionChangedIn(BaseModel):
    """Inbound frame sent by a client when its node selection changes.

    Frozen contract (FE built against these field names):
        {"type": "selection_changed", "flow_id": <int>, "node_ids": [<int>, ...]}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    node_ids: list[int]


class NodeAddedIn(BaseModel):
    """Inbound frame sent by a client when a new node is added to the canvas.

    Frozen contract (FE built against these field names):
        {"type": "node_added", "flow_id": <int>, "node_key": "<str>", "node": {...}}

    ``node_key`` is the frontend uuid for unsaved nodes, or str(backendId) for saved
    nodes.  ``node`` is an opaque serialised NodeModel payload — the FE owns its
    shape; stored and echoed verbatim.
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    node_key: str
    node: dict


class NodeDeletedIn(BaseModel):
    """Inbound frame sent by a client when a node is removed from the canvas.

    Frozen contract (FE built against these field names):
        {"type": "node_deleted", "flow_id": <int>, "node_key": "<str>"}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    node_key: str


class ConnectionAddedIn(BaseModel):
    """Inbound frame sent by a client when a connection is drawn between two nodes.

    Frozen contract (FE built against these field names):
        {
          "type": "connection_added",
          "flow_id": <int>,
          "connection_id": "<str>",
          "source_node_key": "<str>",
          "target_node_key": "<str>",
          "source_port_id": "<str>",
          "target_port_id": "<str>",
          "connection": {...}
        }

    ``connection`` is an opaque serialised connection payload — stored and echoed
    verbatim.  If either endpoint node_key has no node record the frame is
    dropped (recovered on document_state resync).
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    connection_id: str
    source_node_key: str
    target_node_key: str
    source_port_id: str
    target_port_id: str
    connection: dict


class ConnectionRemovedIn(BaseModel):
    """Inbound frame sent by a client when a connection is removed.

    Frozen contract (FE built against these field names):
        {"type": "connection_removed", "flow_id": <int>, "connection_id": "<str>"}
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    flow_id: int
    connection_id: str
