import { computed, inject, Injectable, Signal, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { NodeModel } from '../core/models/node.model';
import { FlowService } from './flow.service';
import { PanelLockService } from './panel-lock.service';

@Injectable({
    providedIn: 'root',
})
export class SidePanelService {
    private readonly selectedNodeIdSignal = signal<string | null>(null);
    private readonly autosaveTriggerSignal = signal<boolean>(false);

    private readonly expandRequestSignal = signal<boolean>(false);
    public readonly expandRequest: Signal<boolean> = this.expandRequestSignal.asReadonly();

    private readonly saveNodeRequestSubject = new Subject<NodeModel>();
    public readonly saveNodeRequest$: Observable<NodeModel> = this.saveNodeRequestSubject.asObservable();

    private readonly graphSavedSubject = new Subject<void>();
    public readonly graphSaved$: Observable<void> = this.graphSavedSubject.asObservable();

    private readonly savingNodeIdSignal = signal<string | null>(null);
    public readonly savingNodeId: Signal<string | null> = this.savingNodeIdSignal.asReadonly();

    public readonly selectedNodeId: Signal<string | null> = this.selectedNodeIdSignal.asReadonly();

    private readonly flowService = inject(FlowService);
    private readonly panelLockService = inject(PanelLockService);

    public readonly selectedNode: Signal<NodeModel | null> = computed(() => {
        const selectedId = this.selectedNodeId();
        if (!selectedId) {
            return null;
        }
        return this.flowService.nodes().find((node) => node.id === selectedId) || null;
    });

    public readonly autosaveTrigger: Signal<boolean> = this.autosaveTriggerSignal.asReadonly();

    public requestExpand(): void {
        this.expandRequestSignal.set(true);
    }

    public clearExpandRequest(): void {
        this.expandRequestSignal.set(false);
    }

    /**
     * Attempts to select a node and open its side panel.
     *
     * Lock rules:
     *  - If the target node has a backendId and another participant holds the lock,
     *    returns false without opening the panel (caller shows the denial toast).
     *  - If the same node is already selected, returns true immediately (idempotent).
     *  - When switching to a new node: autosave + release previous lock (if any),
     *    then select the new node and request its lock (if it has a backendId).
     */
    public trySelectNode(node: NodeModel): boolean {
        const currentId = this.selectedNodeIdSignal();

        if (currentId === node.id) {
            return true;
        }

        // Lock-denied guard: if another participant holds the lock, refuse.
        if (typeof node.backendId === 'number') {
            const holder = this.panelLockService.lockedByOther(node.backendId);
            if (holder !== null) {
                return false;
            }
        }

        // Release lock on the previously held node before moving to the next one.
        this._releaseCurrentLockIfHeld();

        this.triggerAutosave();
        this.setSelectedNodeId(node.id);

        // Request lock for the newly selected node.
        if (typeof node.backendId === 'number') {
            this.panelLockService.requestLock(node.backendId);
        }

        return true;
    }

    public tryClosePanel(): boolean {
        const currentId = this.selectedNodeIdSignal();

        if (!currentId) {
            return true;
        }

        this.triggerAutosave();
        this.clearSelection();
        return true;
    }

    /**
     * Closes the panel after an INVOLUNTARY lock loss (the server already
     * released the lock — e.g. auto-release after the holder disconnected).
     *
     * Unlike tryClosePanel/clearSelection this path:
     *  - sends NO lock-release frame — the server no longer recognises the lock,
     *    and PanelLockService has already cleared heldNodeId when it detected
     *    the loss;
     *  - skips autosave — unsaved edits are intentionally discarded
     *    (last-write-wins; the server is already rejecting this holder's writes).
     */
    public closePanelOnLockLoss(): void {
        this.selectedNodeIdSignal.set(null);
    }

    public clearSelection(): void {
        // Release lock before clearing — the node is still available via selectedNode
        // at this point because we clear the signal after.
        this._releaseCurrentLockIfHeld();
        this.selectedNodeIdSignal.set(null);
    }

    public setSelectedNodeId(nodeId: string | null): void {
        this.selectedNodeIdSignal.set(nodeId);
    }

    public triggerAutosave(): void {
        this.autosaveTriggerSignal.set(!this.autosaveTriggerSignal());
    }

    public clearAutosaveTrigger(): void {
        this.autosaveTriggerSignal.set(false);
    }

    public requestSaveNode(node: NodeModel): void {
        this.saveNodeRequestSubject.next(node);
    }

    public notifyGraphSaved(): void {
        this.graphSavedSubject.next();
    }

    public markNodeSaving(nodeId: string): void {
        this.savingNodeIdSignal.set(nodeId);
    }

    public clearNodeSaving(): void {
        this.savingNodeIdSignal.set(null);
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    /**
     * Releases the lock held by THIS client, if any.
     * Safe to call multiple times — the guard inside releaseLock is idempotent
     * (only releases when heldNodeId matches). This method adds a second guard at
     * the service layer: it only sends a release when the currently selected node
     * has a backendId that matches the held lock.
     *
     * "Release-never-twice" guarantee:
     *  1. `PanelLockService.releaseLock` clears `heldNodeId` optimistically on the
     *     first call, so any subsequent call where heldNodeId no longer matches is
     *     a no-op at the PanelLockService level.
     *  2. This method additionally checks the currently selected node's backendId
     *     against the PanelLockService heldNodeId, so it only ever releases when
     *     there is an actual held lock to release.
     */
    private _releaseCurrentLockIfHeld(): void {
        const heldNodeId = this.panelLockService.heldNodeId();
        if (heldNodeId === null) {
            return;
        }
        // Only release when the held id matches a current selection context.
        // This prevents stale releases if setSelectedNodeId was called directly
        // without going through trySelectNode.
        const currentNode = this.selectedNode();
        if (currentNode !== null && typeof currentNode.backendId === 'number' && currentNode.backendId === heldNodeId) {
            this.panelLockService.releaseLock(heldNodeId);
        }
    }
}
