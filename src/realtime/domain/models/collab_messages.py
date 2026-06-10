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
