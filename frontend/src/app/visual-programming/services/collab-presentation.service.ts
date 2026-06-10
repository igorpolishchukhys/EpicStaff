import { computed, Injectable, Signal, signal } from '@angular/core';

import { getParticipantColor } from '../../pages/flows-page/components/flow-visual-programming/components/presence-avatar-stack/collab-colors';
import { PresenceParticipant } from '../../services/collaboration/collab-message.model';

export interface RemoteCursorState {
    x: number;
    y: number;
    userId: number;
    displayName: string;
}

export interface RemoteSelectionState {
    nodeIds: Set<number>;
    userId: number;
    displayName: string;
}

/**
 * Holds presentation-only state for live collaboration overlays: remote cursors
 * and remote selection outlines. This service never touches FlowService or undo.
 *
 * providedIn: 'root' — a single instance lives for the app lifetime. Call
 * `clear()` whenever the local user navigates away from a flow so stale cursors
 * from the previous session are not shown when a new flow is loaded.
 */
@Injectable({ providedIn: 'root' })
export class CollabPresentationService {
    // --- Private state ---
    private readonly _remoteCursors = signal<Map<string, RemoteCursorState>>(new Map());
    private readonly _remoteSelections = signal<Map<string, RemoteSelectionState>>(new Map());

    // --- Public read-only signals ---
    readonly remoteCursors: Signal<Map<string, RemoteCursorState>> = this._remoteCursors.asReadonly();
    readonly remoteSelections: Signal<Map<string, RemoteSelectionState>> = this._remoteSelections.asReadonly();

    /**
     * Derived map: backendNodeId → {color, displayName} for the first remote
     * participant that has this node in their selection. Used by FlowBaseNodeComponent
     * to render the selection outline.
     */
    readonly nodeSelectionMap: Signal<Map<number, { color: string; displayName: string }>> = computed(() => {
        const result = new Map<number, { color: string; displayName: string }>();
        for (const [, sel] of this._remoteSelections()) {
            const color = this.getColorForUserId(sel.userId);
            for (const nodeId of sel.nodeIds) {
                // First writer wins — if two remote users select the same node,
                // one color is shown. This is an acceptable simplification.
                if (!result.has(nodeId)) {
                    result.set(nodeId, { color, displayName: sel.displayName });
                }
            }
        }
        return result;
    });

    // --- Public mutation methods ---

    upsertCursor(origin: string, x: number, y: number, userId: number, displayName: string): void {
        this._remoteCursors.update((map) => {
            const next = new Map(map);
            next.set(origin, { x, y, userId, displayName });
            return next;
        });
    }

    setSelection(origin: string, nodeIds: Set<number>, userId: number, displayName: string): void {
        this._remoteSelections.update((map) => {
            const next = new Map(map);
            if (nodeIds.size === 0) {
                next.delete(origin);
            } else {
                next.set(origin, { nodeIds, userId, displayName });
            }
            return next;
        });
    }

    removeMember(origin: string): void {
        this._remoteCursors.update((map) => {
            if (!map.has(origin)) return map;
            const next = new Map(map);
            next.delete(origin);
            return next;
        });
        this._remoteSelections.update((map) => {
            if (!map.has(origin)) return map;
            const next = new Map(map);
            next.delete(origin);
            return next;
        });
    }

    /**
     * Drops entries whose userId is no longer in the live participant list.
     * Call whenever `participants` signal changes.
     */
    pruneToUsers(liveUserIds: Set<number>): void {
        this._remoteCursors.update((map) => {
            let changed = false;
            const next = new Map(map);
            for (const [key, val] of map) {
                if (!liveUserIds.has(val.userId)) {
                    next.delete(key);
                    changed = true;
                }
            }
            return changed ? next : map;
        });
        this._remoteSelections.update((map) => {
            let changed = false;
            const next = new Map(map);
            for (const [key, val] of map) {
                if (!liveUserIds.has(val.userId)) {
                    next.delete(key);
                    changed = true;
                }
            }
            return changed ? next : map;
        });
    }

    /** Reset all state — call on flow destroy or navigation. */
    clear(): void {
        this._remoteCursors.set(new Map());
        this._remoteSelections.set(new Map());
    }

    // --- Helpers ---

    getColorForUserId(userId: number): string {
        // Delegates to getParticipantColor from COLLAB_PARTICIPANT_PALETTE
        // (presence-avatar-stack/collab-colors.ts) — single source of truth.
        return getParticipantColor(userId);
    }

    resolveDisplayName(userId: number, participants: PresenceParticipant[]): string {
        const participant = participants.find((p) => p.user_id === userId);
        return participant?.display_name ?? `User ${userId}`;
    }
}
