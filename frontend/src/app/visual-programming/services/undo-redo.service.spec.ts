/**
 * Specs for EST-10 per-user op-based undo/redo service.
 *
 * Covered:
 * - undo-of-add deletes the node
 * - undo-of-delete re-adds node and restores its connections (structural assertion)
 * - undo-of-move restores prior position
 * - redo re-applies the forward ops
 * - new local op clears redo
 * - remote op does NOT clear redo (applyRemoteAddNode drives through FlowService, which
 *   intentionally bypasses recordOp — redo stack remains intact)
 * - gesture batch undoes as one unit
 * - solo (no peers) works correctly
 * - replaying flag suppresses re-recording
 * - setUndoStack / setRedoStack clear the respective stacks (host compat)
 * - clear() empties both stacks
 * - abortBatch discards in-flight batch without committing
 * - isBatchOpen reflects open/closed state
 */
import { TestBed } from '@angular/core/testing';

import { NodeType } from '../core/enums/node-type';
import { ConnectionModel } from '../core/models/connection.model';
import { FlowModel } from '../core/models/flow.model';
import { NodeModel } from '../core/models/node.model';
import {
    FlowOp,
    OpAddConnection,
    OpAddNode,
    OpDeleteNode,
    OpMoveNode,
    OpRemoveConnection,
    OpUpdateNodeData,
} from '../core/models/undo-redo-op.model';
import { FlowService } from './flow.service';
import { UndoRedoService } from './undo-redo.service';

// ---------------------------------------------------------------------------
// Minimal factories
// ---------------------------------------------------------------------------

function makeNode(id: string): NodeModel {
    return {
        id,
        backendId: null,
        type: NodeType.AGENT,
        node_name: `node-${id}`,
        position: { x: 0, y: 0 },
        ports: [],
        color: '#fff',
        icon: 'agent',
        size: { width: 100, height: 100 },
        input_map: {},
        output_variable_path: null,
        data: {} as NodeModel['data'],
    } as NodeModel;
}

function makeConnection(id: string, sourceNodeId = 'src', targetNodeId = 'tgt'): ConnectionModel {
    return {
        id,
        category: 'default',
        sourceNodeId,
        targetNodeId,
        sourcePortId: `${sourceNodeId}_output` as ConnectionModel['sourcePortId'],
        targetPortId: `${targetNodeId}_input` as ConnectionModel['targetPortId'],
        behavior: 'fixed',
        type: 'segment',
        data: null,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addNodeOp(node: NodeModel): FlowOp {
    return { kind: 'add_node', node } satisfies OpAddNode;
}

function deleteNodeOp(node: NodeModel, removedConnections: ConnectionModel[] = []): FlowOp {
    return { kind: 'delete_node', node, removedConnections } satisfies OpDeleteNode;
}

function moveNodeOp(nodeId: string, from: { x: number; y: number }, to: { x: number; y: number }): FlowOp {
    return { kind: 'move_node', nodeId, fromPosition: from, toPosition: to } satisfies OpMoveNode;
}

function updateNodeDataOp(previousNode: NodeModel, updatedNode: NodeModel): FlowOp {
    return { kind: 'update_node_data', previousNode, updatedNode } satisfies OpUpdateNodeData;
}

function addConnectionOp(conn: ConnectionModel): FlowOp {
    return { kind: 'add_connection', connection: conn } satisfies OpAddConnection;
}

function removeConnectionOp(conn: ConnectionModel): FlowOp {
    return { kind: 'remove_connection', connection: conn } satisfies OpRemoveConnection;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UndoRedoService (op-based, EST-10)', () => {
    let service: UndoRedoService;
    let flowService: FlowService;

    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [UndoRedoService, FlowService] });
        service = TestBed.inject(UndoRedoService);
        flowService = TestBed.inject(FlowService);
    });

    // --- stack initial state ---

    it('starts with empty stacks and both canUndo/canRedo false', () => {
        expect(service.canUndo()).toBeFalse();
        expect(service.canRedo()).toBeFalse();
    });

    // --- recordOp basics ---

    it('recordOp adds an entry to undo stack and sets canUndo true', () => {
        const node = makeNode('n1');
        service.recordOp(addNodeOp(node));
        expect(service.canUndo()).toBeTrue();
    });

    it('recordOp clears the redo stack', () => {
        const node = makeNode('n1');
        service.recordOp(addNodeOp(node));
        // Establish redo entry by undoing first.
        service.popUndo();
        expect(service.canRedo()).toBeTrue();

        // New local op should clear redo.
        service.recordOp(addNodeOp(makeNode('n2')));
        expect(service.canRedo()).toBeFalse();
    });

    // --- undo-of-add deletes the node ---

    it('undo-of-add returns inverse delete_node op', () => {
        const node = makeNode('n1');
        service.recordOp(addNodeOp(node));

        const batch = service.popUndo();
        expect(batch).not.toBeNull();
        expect(batch!.inverse.length).toBe(1);
        expect(batch!.inverse[0].kind).toBe('delete_node');
        expect((batch!.inverse[0] as OpDeleteNode).node.id).toBe('n1');
    });

    // --- undo-of-delete re-adds node and its connections ---

    it('undo-of-delete: inverse op is add_node and removedConnections are carried so they can be re-added', () => {
        const node = makeNode('n1');
        const conn = makeConnection('c1', 'n1', 'n2');
        service.recordOp(deleteNodeOp(node, [conn]));

        const batch = service.popUndo();
        expect(batch).not.toBeNull();

        // The direct inverse of a delete_node is an add_node.
        expect(batch!.inverse.length).toBe(1);
        const addOp = batch!.inverse[0] as OpAddNode;
        expect(addOp.kind).toBe('add_node');
        // Node identity preserved.
        expect(addOp.node.id).toBe('n1');

        // Verify the redo forward op still carries the connection so a redo-delete
        // can remove it again.
        expect(batch!.forward.length).toBe(1);
        const deleteOp = batch!.forward[0] as OpDeleteNode;
        expect(deleteOp.removedConnections.length).toBe(1);
        expect(deleteOp.removedConnections[0].id).toBe('c1');
    });

    it('undo-of-delete with connection: simulating executeSingleOp restores the connection in FlowService', () => {
        // Seed FlowService with two nodes and a connection so the "delete" op is
        // representative of real state.
        const n1 = makeNode('n1');
        const n2 = makeNode('n2');
        const conn = makeConnection('c1', 'n1', 'n2');
        const initialFlow: FlowModel = { nodes: [n1, n2], connections: [conn] };
        flowService.setFlow(initialFlow);

        // Record the delete_node op (as deleteSelections would do in the component).
        service.recordOp(deleteNodeOp(n1, [conn]));
        // Simulate FlowService side of the delete.
        flowService.setFlow({ nodes: [n2], connections: [] });

        // Pop undo — should give add_node inverse.
        const batch = service.popUndo();
        expect(batch).not.toBeNull();
        const inverseOp = batch!.inverse[0] as OpAddNode;
        expect(inverseOp.kind).toBe('add_node');

        // Simulate executeSingleOp for add_node: re-add the node.
        flowService.addNode(inverseOp.node);
        // Simulate re-adding the removed connections (as executeSingleOp('delete_node')
        // iterates removedConnections and calls addConnection for each).
        // We re-construct this from the redo forward op which carries removedConnections.
        const redoDeleteOp = batch!.forward[0] as OpDeleteNode;
        for (const removedConn of redoDeleteOp.removedConnections) {
            flowService.addConnection(removedConn);
        }

        // Assert: the connection is back in FlowService.
        const connections = flowService.connections();
        expect(connections.some((c) => c.id === 'c1')).toBeTrue();
        const nodes = flowService.nodes();
        expect(nodes.some((n) => n.id === 'n1')).toBeTrue();
    });

    it('undo-of-delete forward op can redo the delete', () => {
        const node = makeNode('n1');
        service.recordOp(deleteNodeOp(node, []));

        // Undo to get inverse (add_node).
        service.popUndo();

        // Redo re-applies the forward op (delete_node).
        const redoBatch = service.popRedo();
        expect(redoBatch).not.toBeNull();
        expect(redoBatch!.forward.length).toBe(1);
        expect(redoBatch!.forward[0].kind).toBe('delete_node');
    });

    // --- undo-of-move restores prior position ---

    it('undo-of-move returns inverse move with from/to swapped', () => {
        const from = { x: 10, y: 20 };
        const to = { x: 30, y: 40 };
        service.recordOp(moveNodeOp('n1', from, to));

        const batch = service.popUndo();
        expect(batch).not.toBeNull();
        const inverseOp = batch!.inverse[0] as OpMoveNode;
        expect(inverseOp.kind).toBe('move_node');
        expect(inverseOp.fromPosition).toEqual(to);
        expect(inverseOp.toPosition).toEqual(from);
    });

    // --- undo-of-add-connection removes it; undo-of-remove-connection re-adds it ---

    it('undo-of-add_connection returns inverse remove_connection', () => {
        const conn = makeConnection('c1');
        service.recordOp(addConnectionOp(conn));

        const batch = service.popUndo();
        expect(batch!.inverse[0].kind).toBe('remove_connection');
        expect((batch!.inverse[0] as OpRemoveConnection).connection.id).toBe('c1');
    });

    it('undo-of-remove_connection returns inverse add_connection', () => {
        const conn = makeConnection('c1');
        service.recordOp(removeConnectionOp(conn));

        const batch = service.popUndo();
        expect(batch!.inverse[0].kind).toBe('add_connection');
        expect((batch!.inverse[0] as OpAddConnection).connection.id).toBe('c1');
    });

    // --- redo re-applies ---

    it('redo re-applies the original forward op', () => {
        const node = makeNode('n1');
        service.recordOp(addNodeOp(node));

        service.popUndo(); // undo
        const redoBatch = service.popRedo(); // redo
        expect(redoBatch).not.toBeNull();
        expect(redoBatch!.forward[0].kind).toBe('add_node');
        expect((redoBatch!.forward[0] as OpAddNode).node.id).toBe('n1');
    });

    it('after redo the batch is back on the undo stack', () => {
        const node = makeNode('n1');
        service.recordOp(addNodeOp(node));

        service.popUndo();
        service.popRedo();

        expect(service.canUndo()).toBeTrue();
        expect(service.canRedo()).toBeFalse();
    });

    // --- new local op clears redo ---

    it('new local op after undo clears redo stack', () => {
        service.recordOp(addNodeOp(makeNode('n1')));
        service.popUndo(); // redo now has 1 entry
        expect(service.canRedo()).toBeTrue();

        service.recordOp(addNodeOp(makeNode('n2'))); // new local op
        expect(service.canRedo()).toBeFalse();
    });

    // --- remote op does NOT clear redo ---

    it('FlowService.applyRemoteAddNode does NOT clear redo (drives the real remote path)', () => {
        // Establish a local op then undo it — redo stack now has 1 entry.
        service.recordOp(addNodeOp(makeNode('n1')));
        service.popUndo();
        expect(service.canRedo()).toBeTrue();

        // Drive an actual remote structural op through FlowService.applyRemoteAddNode.
        // applyRemote* methods intentionally bypass recordOp — this test asserts that
        // contract holds so the redo stack remains intact.
        const remoteNode = makeNode('r1');
        flowService.setFlow({ nodes: [], connections: [] });
        flowService.applyRemoteAddNode('r1', remoteNode);

        // The node was added to FlowService.
        expect(flowService.nodes().some((n) => n.id === 'r1')).toBeTrue();
        // The redo stack is still intact — the remote op never touched UndoRedoService.
        expect(service.canRedo()).toBeTrue();
    });

    // --- gesture batch undoes as one unit ---

    it('batch gesture undoes all ops atomically', () => {
        const n1 = makeNode('n1');
        const n2 = makeNode('n2');

        service.beginBatch();
        service.recordOp(addNodeOp(n1));
        service.recordOp(addNodeOp(n2));
        service.endBatch();

        // One undo entry for the whole batch.
        expect(service.canUndo()).toBeTrue();
        const batch = service.popUndo();
        expect(batch).not.toBeNull();
        // Inverse is reversed: n2 deleted first, then n1.
        expect(batch!.inverse.length).toBe(2);
        expect(batch!.inverse[0].kind).toBe('delete_node');
        expect((batch!.inverse[0] as OpDeleteNode).node.id).toBe('n2');
        expect(batch!.inverse[1].kind).toBe('delete_node');
        expect((batch!.inverse[1] as OpDeleteNode).node.id).toBe('n1');

        // After undoing that one batch the undo stack is empty.
        expect(service.canUndo()).toBeFalse();
    });

    it('empty batch is discarded without adding an undo entry', () => {
        service.beginBatch();
        service.endBatch();
        expect(service.canUndo()).toBeFalse();
    });

    // --- solo (no peers) still works ---

    it('solo undo/redo cycle completes correctly without peers', () => {
        const node = makeNode('n1');
        service.recordOp(addNodeOp(node));

        const undoBatch = service.popUndo();
        expect(undoBatch).not.toBeNull();
        expect(undoBatch!.inverse[0].kind).toBe('delete_node');

        const redoBatch = service.popRedo();
        expect(redoBatch).not.toBeNull();
        expect(redoBatch!.forward[0].kind).toBe('add_node');
    });

    // --- replaying flag suppresses re-recording ---

    it('recordOp is a no-op when replaying = true', () => {
        service.replaying = true;
        service.recordOp(addNodeOp(makeNode('n1')));
        service.replaying = false;

        expect(service.canUndo()).toBeFalse();
    });

    // --- host compat: setUndoStack / setRedoStack ---

    it('setUndoStack([]) clears the undo stack', () => {
        service.recordOp(addNodeOp(makeNode('n1')));
        expect(service.canUndo()).toBeTrue();

        service.setUndoStack([]);
        expect(service.canUndo()).toBeFalse();
    });

    it('setRedoStack([]) clears the redo stack', () => {
        service.recordOp(addNodeOp(makeNode('n1')));
        service.popUndo();
        expect(service.canRedo()).toBeTrue();

        service.setRedoStack([]);
        expect(service.canRedo()).toBeFalse();
    });

    // --- clear() convenience ---

    it('clear() empties both stacks', () => {
        service.recordOp(addNodeOp(makeNode('n1')));
        service.popUndo(); // puts one on redo

        service.clear();
        expect(service.canUndo()).toBeFalse();
        expect(service.canRedo()).toBeFalse();
    });

    // --- update_node_data inverse ---

    it('undo-of-update_node_data swaps previous/updated', () => {
        const prev = makeNode('n1');
        const updated = { ...prev, node_name: 'updated' } as NodeModel;
        service.recordOp(updateNodeDataOp(prev, updated));

        const batch = service.popUndo();
        const inverseOp = batch!.inverse[0] as OpUpdateNodeData;
        expect(inverseOp.kind).toBe('update_node_data');
        expect(inverseOp.updatedNode.node_name).toBe(prev.node_name);
        expect(inverseOp.previousNode.node_name).toBe(updated.node_name);
    });

    // --- popUndo/popRedo return null on empty stacks ---

    it('popUndo returns null on empty stack', () => {
        expect(service.popUndo()).toBeNull();
    });

    it('popRedo returns null on empty stack', () => {
        expect(service.popRedo()).toBeNull();
    });

    // --- isBatchOpen reflects state ---

    it('isBatchOpen is false initially and true after beginBatch', () => {
        expect(service.isBatchOpen).toBeFalse();
        service.beginBatch();
        expect(service.isBatchOpen).toBeTrue();
        service.endBatch();
        expect(service.isBatchOpen).toBeFalse();
    });

    // --- abortBatch discards in-flight batch ---

    it('abortBatch discards an open batch without adding an undo entry', () => {
        service.beginBatch();
        service.recordOp(addNodeOp(makeNode('n1')));
        service.abortBatch();

        // Batch was discarded — nothing on the undo stack.
        expect(service.canUndo()).toBeFalse();
        expect(service.isBatchOpen).toBeFalse();
    });

    it('abortBatch is a no-op when no batch is open', () => {
        expect(() => service.abortBatch()).not.toThrow();
        expect(service.isBatchOpen).toBeFalse();
    });

    // --- beginBatch resilience: open batch while one is already open ---

    it('beginBatch while a batch is open closes prior batch and starts a new one', () => {
        service.beginBatch();
        service.recordOp(addNodeOp(makeNode('n1')));
        // Re-open — prior batch with n1 should be committed.
        service.beginBatch();
        expect(service.isBatchOpen).toBeTrue();
        service.endBatch(); // empty new batch

        // The first batch (n1) was committed and is on the undo stack.
        expect(service.canUndo()).toBeTrue();
        const batch = service.popUndo();
        expect(batch!.forward[0].kind).toBe('add_node');
        expect((batch!.forward[0] as OpAddNode).node.id).toBe('n1');
    });

    // --- endBatch is a no-op when no batch is open ---

    it('endBatch when no batch is open logs a warning but does not throw', () => {
        expect(() => service.endBatch()).not.toThrow();
    });
});
