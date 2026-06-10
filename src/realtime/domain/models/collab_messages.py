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
