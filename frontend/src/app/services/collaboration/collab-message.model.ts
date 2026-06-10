export interface PresenceMessage {
    type: 'presence';
    flow_id: number;
    count: number;
}

export interface NodeMovedMessage {
    type: 'node_moved';
    flow_id: number;
    node_id: number;
    x: number;
    y: number;
    origin: string;
}

export interface DocumentStateMessage {
    type: 'document_state';
    flow_id: number;
    positions: Record<string, { x: number; y: number }>;
}

/** Outbound payload sent by the local client when the user moves a node. */
export interface NodeMoveOp {
    node_id: number;
    x: number;
    y: number;
}

export type CollabConnectionState = 'disconnected' | 'connecting' | 'connected';

export function isPresenceMessage(value: unknown): value is PresenceMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'presence' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['count'] === 'number'
    );
}

export function isNodeMovedMessage(value: unknown): value is NodeMovedMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'node_moved' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['node_id'] === 'number' &&
        typeof record['x'] === 'number' &&
        typeof record['y'] === 'number' &&
        typeof record['origin'] === 'string'
    );
}

export function isDocumentStateMessage(value: unknown): value is DocumentStateMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'document_state' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['positions'] === 'object' &&
        record['positions'] !== null
    );
}
