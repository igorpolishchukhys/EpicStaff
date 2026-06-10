export interface PresenceParticipant {
    user_id: number;
    display_name: string | null;
}

export interface PresenceMessage {
    type: 'presence';
    flow_id: number;
    count: number;
    participants?: PresenceParticipant[];
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

export interface CursorMovedMessage {
    type: 'cursor_moved';
    flow_id: number;
    x: number;
    y: number;
    origin: string;
    user_id: number;
}

export interface SelectionChangedMessage {
    type: 'selection_changed';
    flow_id: number;
    node_ids: number[];
    origin: string;
    user_id: number;
}

export interface SelfIdentityMessage {
    type: 'self';
    flow_id: number;
    member_id: string;
    user_id: number;
}

export interface LockGrantedMessage {
    type: 'lock_granted';
    flow_id: number;
    node_id: number;
}

export interface LockDeniedMessage {
    type: 'lock_denied';
    flow_id: number;
    node_id: number;
    holder_user_id: number;
}

export interface NodeLockedMessage {
    type: 'node_locked';
    flow_id: number;
    node_id: number;
    origin: string;
    user_id: number;
}

export interface NodeUnlockedMessage {
    type: 'node_unlocked';
    flow_id: number;
    node_id: number;
    origin: string;
    /** Present only when the server auto-released the lock after the holder disconnected. */
    reason?: 'disconnected';
}

export interface LockStateEntry {
    member_id: string;
    user_id: number;
}

export interface LockStateMessage {
    type: 'lock_state';
    flow_id: number;
    locks: Record<string, LockStateEntry>;
}

/** Direct server reply to an outbound heartbeat frame (not broadcast to other members). */
export interface HeartbeatAckMessage {
    type: 'heartbeat_ack';
    flow_id: number;
}

export interface NodeDataUpdatedMessage {
    type: 'node_data_updated';
    flow_id: number;
    node_id: number;
    node_name: string;
    data: Record<string, unknown>;
    origin: string;
}

/** Outbound payload sent by the local client when the user moves their cursor. */
export interface CursorMoveOp {
    x: number;
    y: number;
}

/** Outbound payload sent by the local client when the user changes their selection. */
export interface SelectionOp {
    node_ids: number[];
}

/** Outbound payload sent by the local client to request a lock on a node. */
export interface LockRequestOp {
    node_id: number;
}

/** Outbound payload sent by the local client to release a lock on a node. */
export interface LockReleaseOp {
    node_id: number;
}

/** Outbound payload sent by the local client when the user edits a node's data. */
export interface NodeDataUpdateOp {
    node_id: number;
    node_name: string;
    data: Record<string, unknown>;
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

export function isCursorMovedMessage(value: unknown): value is CursorMovedMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'cursor_moved' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['x'] === 'number' &&
        typeof record['y'] === 'number' &&
        typeof record['origin'] === 'string' &&
        typeof record['user_id'] === 'number'
    );
}

export function isSelectionChangedMessage(value: unknown): value is SelectionChangedMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'selection_changed' &&
        typeof record['flow_id'] === 'number' &&
        Array.isArray(record['node_ids']) &&
        typeof record['origin'] === 'string' &&
        typeof record['user_id'] === 'number'
    );
}

export function isSelfIdentityMessage(value: unknown): value is SelfIdentityMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'self' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['member_id'] === 'string' &&
        typeof record['user_id'] === 'number'
    );
}

export function isLockGrantedMessage(value: unknown): value is LockGrantedMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'lock_granted' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['node_id'] === 'number'
    );
}

export function isLockDeniedMessage(value: unknown): value is LockDeniedMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'lock_denied' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['node_id'] === 'number' &&
        typeof record['holder_user_id'] === 'number'
    );
}

export function isNodeLockedMessage(value: unknown): value is NodeLockedMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'node_locked' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['node_id'] === 'number' &&
        typeof record['origin'] === 'string' &&
        typeof record['user_id'] === 'number'
    );
}

export function isNodeUnlockedMessage(value: unknown): value is NodeUnlockedMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'node_unlocked' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['node_id'] === 'number' &&
        typeof record['origin'] === 'string'
    );
}

export function isLockStateMessage(value: unknown): value is LockStateMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'lock_state' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['locks'] === 'object' &&
        record['locks'] !== null
    );
}

export function isHeartbeatAckMessage(value: unknown): value is HeartbeatAckMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'heartbeat_ack' &&
        typeof record['flow_id'] === 'number'
    );
}

export function isNodeDataUpdatedMessage(value: unknown): value is NodeDataUpdatedMessage {
    const record = value as Record<string, unknown>;
    return (
        typeof value === 'object' &&
        value !== null &&
        record['type'] === 'node_data_updated' &&
        typeof record['flow_id'] === 'number' &&
        typeof record['node_id'] === 'number' &&
        typeof record['node_name'] === 'string' &&
        typeof record['data'] === 'object' &&
        record['data'] !== null &&
        typeof record['origin'] === 'string'
    );
}
