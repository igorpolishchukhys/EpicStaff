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
