import { inject, Injectable, Signal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { CollaborationPresenceService } from '../../services/collaboration/collaboration-presence.service';

export interface LockEntry {
    memberId: string;
    userId: number;
}

/**
 * Tracks the panel-lock state for the flow editor.
 *
 * - `locks` — map of backend node id → {memberId, userId} for every node that is
 *   currently locked by any participant (including the local user).
 * - `heldNodeId` — the backend node id that THIS client currently holds a lock on
 *   (at most one at a time).
 *
 * Consumers call `requestLock` / `releaseLock` to drive the lock lifecycle.
 * Display-name resolution is left to consumers via `CollaborationPresenceService.participants`.
 */
@Injectable({ providedIn: 'root' })
export class PanelLockService {
    private readonly _locks = signal<Map<number, LockEntry>>(new Map());
    private readonly _heldNodeId = signal<number | null>(null);

    readonly locks: Signal<Map<number, LockEntry>> = this._locks.asReadonly();
    readonly heldNodeId: Signal<number | null> = this._heldNodeId.asReadonly();

    private readonly collaborationPresenceService = inject(CollaborationPresenceService);

    constructor() {
        // node_locked — upsert entry; if origin is ours, also record heldNodeId.
        this.collaborationPresenceService.nodeLocked$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            this._locks.update((map) => {
                const next = new Map(map);
                next.set(msg.node_id, { memberId: msg.origin, userId: msg.user_id });
                return next;
            });

            const selfId = this.collaborationPresenceService.selfMemberId();
            if (selfId !== null && msg.origin === selfId) {
                this._heldNodeId.set(msg.node_id);
            }
        });

        // node_unlocked — delete entry; clear heldNodeId if it was ours.
        this.collaborationPresenceService.nodeUnlocked$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            this._locks.update((map) => {
                if (!map.has(msg.node_id)) {
                    return map;
                }
                const next = new Map(map);
                next.delete(msg.node_id);
                return next;
            });

            const selfId = this.collaborationPresenceService.selfMemberId();
            if (selfId !== null && msg.origin === selfId) {
                if (this._heldNodeId() === msg.node_id) {
                    this._heldNodeId.set(null);
                }
            }
        });

        // lock_state — full replacement of the lock map (sent on connect/reconnect).
        this.collaborationPresenceService.lockState$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            const next = new Map<number, LockEntry>();
            for (const [key, entry] of Object.entries(msg.locks)) {
                const nodeId = Number(key);
                if (Number.isFinite(nodeId)) {
                    next.set(nodeId, { memberId: entry.member_id, userId: entry.user_id });
                }
            }
            this._locks.set(next);

            // Re-compute heldNodeId from the new full state.
            const selfId = this.collaborationPresenceService.selfMemberId();
            if (selfId !== null) {
                let heldId: number | null = null;
                for (const [nodeId, entry] of next) {
                    if (entry.memberId === selfId) {
                        heldId = nodeId;
                        break;
                    }
                }
                this._heldNodeId.set(heldId);
            }
        });

        // lock_granted — server confirmation that we own the lock.
        this.collaborationPresenceService.lockGranted$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            this._heldNodeId.set(msg.node_id);
        });
    }

    /**
     * Returns the lock entry for a node if it is held by a DIFFERENT participant.
     * Returns null when the node is unlocked or held by the local user.
     */
    lockedByOther(backendId: number): LockEntry | null {
        const entry = this._locks().get(backendId);
        if (!entry) {
            return null;
        }
        const selfId = this.collaborationPresenceService.selfMemberId();
        if (selfId !== null && entry.memberId === selfId) {
            return null;
        }
        return entry;
    }

    /** Send a lock request to the server for the given backend node id. */
    requestLock(backendId: number): void {
        this.collaborationPresenceService.sendLockRequest({ node_id: backendId });
    }

    /**
     * Optimistically clears the local held-node id and sends a release to the server.
     * The server will broadcast node_unlocked which removes the entry from `locks`.
     */
    releaseLock(backendId: number): void {
        if (this._heldNodeId() === backendId) {
            this._heldNodeId.set(null);
        }
        this.collaborationPresenceService.sendLockRelease({ node_id: backendId });
    }

    /** Reset all state — call on flow destroy or navigation. */
    clear(): void {
        this._locks.set(new Map());
        this._heldNodeId.set(null);
    }
}
