/**
 * Per-user, operation-based undo/redo model for the flow editor.
 *
 * Each local edit is recorded as a {forward, inverse} op pair.
 * Undo replays inverse ops; redo replays forward ops. Both paths use the
 * normal LOCAL mutation path so they broadcast to collaborators (LWW).
 *
 * A "batch" groups multiple ops that belong to a single user gesture
 * (e.g. multi-node drag or paste). beginBatch()/endBatch() delimit gestures;
 * single-op actions are recorded directly without batching.
 */

import { ConnectionModel } from './connection.model';
import { NodeModel } from './node.model';

// ---------------------------------------------------------------------------
// Atomic op types
// ---------------------------------------------------------------------------

/** Add a single node. Inverse = delete that node (and track its connections). */
export interface OpAddNode {
    readonly kind: 'add_node';
    readonly node: NodeModel;
}

/**
 * Delete a single node and its orphaned connections.
 * Inverse = re-add the node, then re-add the connections.
 * Connections are additive — peers' concurrent connections to the re-added
 * node coexist and are NOT removed.
 */
export interface OpDeleteNode {
    readonly kind: 'delete_node';
    readonly node: NodeModel;
    /** All connections that were removed because of this node deletion. */
    readonly removedConnections: ConnectionModel[];
}

/** Move a node from one position to another. Inverse = move to prior position. */
export interface OpMoveNode {
    readonly kind: 'move_node';
    readonly nodeId: string;
    readonly fromPosition: { readonly x: number; readonly y: number };
    readonly toPosition: { readonly x: number; readonly y: number };
}

/**
 * Update a node's data/name/ports.
 * Inverse = restore prior state by replacing the node with the previous version.
 */
export interface OpUpdateNodeData {
    readonly kind: 'update_node_data';
    readonly previousNode: NodeModel;
    readonly updatedNode: NodeModel;
}

/** Add a connection. Inverse = remove it. */
export interface OpAddConnection {
    readonly kind: 'add_connection';
    readonly connection: ConnectionModel;
}

/** Remove a connection. Inverse = re-add it. */
export interface OpRemoveConnection {
    readonly kind: 'remove_connection';
    readonly connection: ConnectionModel;
}

/** Union of all atomic op types. */
export type FlowOp = OpAddNode | OpDeleteNode | OpMoveNode | OpUpdateNodeData | OpAddConnection | OpRemoveConnection;

// ---------------------------------------------------------------------------
// Batch entry — one undo stack entry = one or more atomic ops
// ---------------------------------------------------------------------------

/**
 * An undo entry.
 * `forward` holds the op(s) that produced the current state (needed to re-apply on redo).
 * `inverse` holds the op(s) needed to reverse the gesture.
 * Both are applied atomically.
 */
export interface UndoBatch {
    /** One or more ops representing the original forward gesture. Applied on redo. */
    readonly forward: readonly FlowOp[];
    /** One or more ops that revert the gesture. Applied on undo. */
    readonly inverse: readonly FlowOp[];
}

// ---------------------------------------------------------------------------
// Helpers — invert a single op
// ---------------------------------------------------------------------------

/**
 * Derives the inverse of a single forward op.
 * Used internally when recording; callers of UndoRedoService pass forward ops
 * and receive automatically-computed inverses.
 */
export function invertOp(op: FlowOp): FlowOp {
    switch (op.kind) {
        case 'add_node':
            return {
                kind: 'delete_node',
                node: op.node,
                removedConnections: [],
            } satisfies OpDeleteNode;

        case 'delete_node':
            return {
                kind: 'add_node',
                node: op.node,
            } satisfies OpAddNode;

        case 'move_node':
            return {
                kind: 'move_node',
                nodeId: op.nodeId,
                fromPosition: op.toPosition,
                toPosition: op.fromPosition,
            } satisfies OpMoveNode;

        case 'update_node_data':
            return {
                kind: 'update_node_data',
                previousNode: op.updatedNode,
                updatedNode: op.previousNode,
            } satisfies OpUpdateNodeData;

        case 'add_connection':
            return {
                kind: 'remove_connection',
                connection: op.connection,
            } satisfies OpRemoveConnection;

        case 'remove_connection':
            return {
                kind: 'add_connection',
                connection: op.connection,
            } satisfies OpAddConnection;
    }
}
