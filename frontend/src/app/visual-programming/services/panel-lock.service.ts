import { inject, Injectable, Signal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject } from 'rxjs';

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
    // Private fields. Declared before the public read-only views because class
    // field initializers run in declaration order and the views derive from them.
    private readonly _locks = signal<Map<number, LockEntry>>(new Map());
    private readonly _heldNodeId = signal<number | null>(null);
    // INVARIANT: BOTH emit sites (the node_unlocked broadcast handler and the lock_state snapshot handler) must clear `_heldNodeId` before `.next()` — that ordering is what makes loss detection sound.
    private readonly lockLostSubject = new Subject<number>();
    private readonly collaborationPresenceService = inject(CollaborationPresenceService);

    readonly locks: Signal<Map<number, LockEntry>> = this._locks.asReadonly();
    readonly heldNodeId: Signal<number | null> = this._heldNodeId.asReadonly();
    /**
     * Emits the backend node id when the lock held by THIS client is lost
     * INVOLUNTARILY (e.g. the server auto-released it after a disconnect or a
     * silence timeout).
     *
     * Disambiguation invariant: `releaseLock` clears `heldNodeId` synchronously
     * BEFORE the release frame reaches the server, so any unlock observation
     * (node_unlocked broadcast or a lock_state snapshot missing our node) that
     * arrives while `heldNodeId` is still set cannot be the echo of a voluntary
     * release — it is involuntary by construction. Never fires for locks held
     * by other participants or on local `clear()`.
     */
    readonly lockLost$: Observable<number> = this.lockLostSubject.asObservable();

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

        // node_unlocked — delete entry; detect involuntary loss of OUR lock.
        this.collaborationPresenceService.nodeUnlocked$.pipe(takeUntilDestroyed()).subscribe((msg) => {
            this._locks.update((map) => {
                if (!map.has(msg.node_id)) {
                    return map;
                }
                const next = new Map(map);
                next.delete(msg.node_id);
                return next;
            });

            // If heldNodeId still points at this node, the unlock did NOT come
            // from a local releaseLock call (releaseLock clears heldNodeId before
            // the server round-trip) — the server released it on its own.
            // Origin is deliberately not checked: after a reconnect the broadcast
            // may carry our PREVIOUS connection's member id.
            if (this._heldNodeId() === msg.node_id) {
                this._heldNodeId.set(null);
                this.lockLostSubject.next(msg.node_id);
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

                // Involuntary loss across a reconnect: a disconnected holder never
                // sees the node_unlocked broadcast — it learns of the release here,
                // when the fresh snapshot no longer contains its lock (member_id is
                // per-connection, so the old identity never matches). heldNodeId
                // still being set means no local releaseLock happened in between.
                const previousHeldId = this._heldNodeId();
                this._heldNodeId.set(heldId);
                if (previousHeldId !== null && heldId !== previousHeldId) {
                    this.lockLostSubject.next(previousHeldId);
                }
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
