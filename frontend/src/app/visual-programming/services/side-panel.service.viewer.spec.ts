/**
 * Specs for EST-11 viewer-mode gating in SidePanelService.
 *
 * Covered:
 * - RBAC viewer (no 'flows:update'): trySelectNode returns false, no panel, no lock
 * - server-viewer (isViewer=true from WS self frame, RBAC allows): same blocking
 * - composed gate: both gates must pass — either alone blocks
 * - editor (both gates pass): trySelectNode opens the panel and requests a lock
 * - editor: lock-denied by another holder still returns false
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { PermissionsService } from '../../services/auth/permissions.service';
import { CollaborationPresenceService } from '../../services/collaboration/collaboration-presence.service';
import { NodeType } from '../core/enums/node-type';
import { NodeModel } from '../core/models/node.model';
import { FlowService } from './flow.service';
import { LockEntry, PanelLockService } from './panel-lock.service';
import { SidePanelService } from './side-panel.service';

// ---------------------------------------------------------------------------
// Minimal node factory
// ---------------------------------------------------------------------------

function makeNode(id: string, backendId: number | null = null): NodeModel {
    return {
        id,
        backendId,
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

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Minimal PermissionsService stub — `canValue` controls what `can()` returns. */
class PermissionsServiceStub {
    canValue = true;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    can(resource: string, action: string): boolean {
        return this.canValue;
    }
}

/** Minimal PanelLockService stub with spy-able methods. */
class PanelLockServiceStub {
    heldNodeId = signal<number | null>(null);
    locks = signal<Map<number, LockEntry>>(new Map());

    requestLock = jasmine.createSpy('requestLock');
    releaseLock = jasmine.createSpy('releaseLock');

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    lockedByOther(nodeId: number): { memberId: string; userId: number } | null {
        return null;
    }
}

/**
 * Minimal CollaborationPresenceService stub.
 * `isViewerValue` controls what the `isViewer` signal returns.
 */
class CollaborationPresenceServiceStub {
    private readonly _isViewer = signal<boolean>(false);
    readonly isViewer = this._isViewer.asReadonly();

    setIsViewer(value: boolean): void {
        this._isViewer.set(value);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SidePanelService — viewer-mode gating (EST-11)', () => {
    let service: SidePanelService;
    let permissionsStub: PermissionsServiceStub;
    let panelLockStub: PanelLockServiceStub;
    let collabStub: CollaborationPresenceServiceStub;

    beforeEach(() => {
        permissionsStub = new PermissionsServiceStub();
        panelLockStub = new PanelLockServiceStub();
        collabStub = new CollaborationPresenceServiceStub();

        TestBed.configureTestingModule({
            providers: [
                SidePanelService,
                FlowService,
                { provide: PermissionsService, useValue: permissionsStub },
                { provide: PanelLockService, useValue: panelLockStub },
                { provide: CollaborationPresenceService, useValue: collabStub },
            ],
        });

        service = TestBed.inject(SidePanelService);
    });

    // --- RBAC viewer: panel opening blocked by org permission ---

    it('rbac-viewer: trySelectNode returns false without setting selectedNodeId', () => {
        permissionsStub.canValue = false;
        const node = makeNode('n1', 42);

        const result = service.trySelectNode(node);

        expect(result).toBeFalse();
        expect(service.selectedNodeId()).toBeNull();
    });

    it('rbac-viewer: trySelectNode does NOT call panelLockService.requestLock', () => {
        permissionsStub.canValue = false;
        const node = makeNode('n1', 42);

        service.trySelectNode(node);

        expect(panelLockStub.requestLock).not.toHaveBeenCalled();
    });

    it('rbac-viewer: trySelectNode does NOT release a previously held lock', () => {
        permissionsStub.canValue = false;
        // Simulate a held lock from a prior edit session.
        panelLockStub.heldNodeId.set(99);
        const node = makeNode('n1', 42);

        service.trySelectNode(node);

        expect(panelLockStub.releaseLock).not.toHaveBeenCalled();
    });

    it('rbac-viewer: selectedNode remains null after trySelectNode call', () => {
        permissionsStub.canValue = false;
        const node = makeNode('n1', 42);

        service.trySelectNode(node);

        expect(service.selectedNode()).toBeNull();
    });

    // --- Server viewer: panel opening blocked by WS self frame ---

    it('server-viewer: trySelectNode returns false even when RBAC allows', () => {
        permissionsStub.canValue = true; // RBAC would allow
        collabStub.setIsViewer(true); // but server says read-only
        const node = makeNode('n1', 42);

        const result = service.trySelectNode(node);

        expect(result).toBeFalse();
        expect(service.selectedNodeId()).toBeNull();
    });

    it('server-viewer: trySelectNode does NOT call panelLockService.requestLock', () => {
        permissionsStub.canValue = true;
        collabStub.setIsViewer(true);
        const node = makeNode('n1', 42);

        service.trySelectNode(node);

        expect(panelLockStub.requestLock).not.toHaveBeenCalled();
    });

    it('server-viewer: trySelectNode does NOT release a previously held lock', () => {
        permissionsStub.canValue = true;
        collabStub.setIsViewer(true);
        panelLockStub.heldNodeId.set(99);
        const node = makeNode('n1', 42);

        service.trySelectNode(node);

        expect(panelLockStub.releaseLock).not.toHaveBeenCalled();
    });

    // --- Editor: normal behavior preserved (both gates pass) ---

    it('editor: trySelectNode returns true and sets selectedNodeId', () => {
        permissionsStub.canValue = true;
        collabStub.setIsViewer(false);
        const node = makeNode('n1', 42);

        const result = service.trySelectNode(node);

        expect(result).toBeTrue();
        expect(service.selectedNodeId()).toBe('n1');
    });

    it('editor: trySelectNode calls requestLock when node has backendId', () => {
        permissionsStub.canValue = true;
        collabStub.setIsViewer(false);
        const node = makeNode('n1', 42);

        service.trySelectNode(node);

        expect(panelLockStub.requestLock).toHaveBeenCalledWith(42);
    });

    it('editor: trySelectNode returns true idempotently for same node', () => {
        permissionsStub.canValue = true;
        collabStub.setIsViewer(false);
        const node = makeNode('n1', 42);
        service.trySelectNode(node);

        // Reset spy counts.
        panelLockStub.requestLock.calls.reset();

        const result = service.trySelectNode(node);

        expect(result).toBeTrue();
        // Idempotent — no second lock request.
        expect(panelLockStub.requestLock).not.toHaveBeenCalled();
    });

    it('editor: trySelectNode returns false when another participant holds the lock', () => {
        permissionsStub.canValue = true;
        collabStub.setIsViewer(false);
        const node = makeNode('n1', 42);
        // Simulate lock held by peer.
        spyOn(panelLockStub, 'lockedByOther').and.returnValue({ memberId: 'peer-1', userId: 99 });

        const result = service.trySelectNode(node);

        expect(result).toBeFalse();
        expect(service.selectedNodeId()).toBeNull();
        expect(panelLockStub.requestLock).not.toHaveBeenCalled();
    });

    it('editor: trySelectNode for a node without backendId does not request a lock', () => {
        permissionsStub.canValue = true;
        collabStub.setIsViewer(false);
        const node = makeNode('n1', null); // no backendId

        service.trySelectNode(node);

        expect(panelLockStub.requestLock).not.toHaveBeenCalled();
        expect(service.selectedNodeId()).toBe('n1');
    });
});
