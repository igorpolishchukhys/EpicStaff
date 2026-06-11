import { inject, Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { ActiveOrgService } from '../auth/active-org.service';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '../config/config.service';
import {
    CollabConnectionState,
    ConnectionAddedMessage,
    ConnectionAddOp,
    ConnectionRemovedMessage,
    ConnectionRemoveOp,
    CursorMovedMessage,
    CursorMoveOp,
    DocumentStateMessage,
    FlushRequestedMessage,
    isConnectionAddedMessage,
    isConnectionRemovedMessage,
    isCursorMovedMessage,
    isDocumentStateMessage,
    isFlushRequestedMessage,
    isHeartbeatAckMessage,
    isLockDeniedMessage,
    isLockGrantedMessage,
    isLockStateMessage,
    isNodeAddedMessage,
    isNodeDataUpdatedMessage,
    isNodeDeletedMessage,
    isNodeLockedMessage,
    isNodeMovedMessage,
    isNodeUnlockedMessage,
    isOpRejectedMessage,
    isPresenceMessage,
    isSelectionChangedMessage,
    isSelfIdentityMessage,
    LockDeniedMessage,
    LockGrantedMessage,
    LockReleaseOp,
    LockRequestOp,
    LockStateMessage,
    NodeAddedMessage,
    NodeAddOp,
    NodeDataUpdatedMessage,
    NodeDataUpdateOp,
    NodeDeletedMessage,
    NodeDeleteOp,
    NodeLockedMessage,
    NodeMovedMessage,
    NodeMoveOp,
    NodeUnlockedMessage,
    OpRejectedMessage,
    PresenceParticipant,
    SelectionChangedMessage,
    SelectionOp,
} from './collab-message.model';

const RECONNECT_DELAY_MS = 3_000;

/**
 * Heartbeat cadence and zombie-connection detection.
 *
 * The server force-closes a collab socket (and auto-releases the member's node
 * locks) when no inbound frame arrives within 30 seconds. These two constants
 * and that server timeout must change together: the send interval must stay
 * comfortably below the server timeout, and the ack-staleness threshold mirrors
 * it on the client side — three missed acks in a row mean the connection is a
 * zombie and must be torn down so the reconnect path can recover.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_ACK_STALENESS_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class CollaborationPresenceService {
    // --- Signals ---
    readonly participantCount = signal<number>(0);
    readonly participants = signal<PresenceParticipant[]>([]);
    readonly connectionState = signal<CollabConnectionState>('disconnected');
    readonly selfMemberId = signal<string | null>(null);
    /** True when this client is the designated flush member (oldest-joined participant). */
    readonly isDesignated = signal<boolean>(false);
    /**
     * True when the server resolved this connection as read-only (viewer).
     * Set from the inbound `self` frame; reset to false on `disconnect()`.
     * Viewers are prevented from sending mutating operations.
     */
    readonly isViewer = signal<boolean>(false);

    // --- Observables ---
    readonly remoteNodeMove$: Observable<NodeMovedMessage>;
    readonly flushRequested$: Observable<FlushRequestedMessage>;
    readonly documentState$: Observable<DocumentStateMessage>;
    readonly remoteCursor$: Observable<CursorMovedMessage>;
    readonly remoteSelection$: Observable<SelectionChangedMessage>;
    readonly lockGranted$: Observable<LockGrantedMessage>;
    readonly lockDenied$: Observable<LockDeniedMessage>;
    readonly nodeLocked$: Observable<NodeLockedMessage>;
    readonly nodeUnlocked$: Observable<NodeUnlockedMessage>;
    readonly lockState$: Observable<LockStateMessage>;
    readonly remoteNodeDataUpdate$: Observable<NodeDataUpdatedMessage>;
    readonly remoteNodeAdded$: Observable<NodeAddedMessage>;
    readonly remoteNodeDeleted$: Observable<NodeDeletedMessage>;
    readonly remoteConnectionAdded$: Observable<ConnectionAddedMessage>;
    readonly remoteConnectionRemoved$: Observable<ConnectionRemovedMessage>;
    /** Emits when the server rejects an outbound op because this client is a viewer. Normally silent — a firing event indicates a UI-gate gap. */
    readonly opRejected$: Observable<OpRejectedMessage>;

    // --- Private fields ---
    private readonly authService = inject(AuthService);
    private readonly configService = inject(ConfigService);
    private readonly activeOrgService = inject(ActiveOrgService);

    private readonly flushRequestedSubject = new Subject<FlushRequestedMessage>();
    private readonly remoteNodeMoveSubject = new Subject<NodeMovedMessage>();
    private readonly documentStateSubject = new Subject<DocumentStateMessage>();
    private readonly remoteCursorSubject = new Subject<CursorMovedMessage>();
    private readonly remoteSelectionSubject = new Subject<SelectionChangedMessage>();
    private readonly lockGrantedSubject = new Subject<LockGrantedMessage>();
    private readonly lockDeniedSubject = new Subject<LockDeniedMessage>();
    private readonly nodeLockedSubject = new Subject<NodeLockedMessage>();
    private readonly nodeUnlockedSubject = new Subject<NodeUnlockedMessage>();
    private readonly lockStateSubject = new Subject<LockStateMessage>();
    private readonly remoteNodeDataUpdateSubject = new Subject<NodeDataUpdatedMessage>();
    private readonly remoteNodeAddedSubject = new Subject<NodeAddedMessage>();
    private readonly remoteNodeDeletedSubject = new Subject<NodeDeletedMessage>();
    private readonly remoteConnectionAddedSubject = new Subject<ConnectionAddedMessage>();
    private readonly remoteConnectionRemovedSubject = new Subject<ConnectionRemovedMessage>();
    private readonly opRejectedSubject = new Subject<OpRejectedMessage>();

    private socket: WebSocket | null = null;
    private connectedFlowId: number | null = null;
    private intentionalClose = false;
    private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimerId: ReturnType<typeof setInterval> | null = null;
    private lastHeartbeatAckAt: number | null = null;

    constructor() {
        this.flushRequested$ = this.flushRequestedSubject.asObservable();
        this.remoteNodeMove$ = this.remoteNodeMoveSubject.asObservable();
        this.documentState$ = this.documentStateSubject.asObservable();
        this.remoteCursor$ = this.remoteCursorSubject.asObservable();
        this.remoteSelection$ = this.remoteSelectionSubject.asObservable();
        this.lockGranted$ = this.lockGrantedSubject.asObservable();
        this.lockDenied$ = this.lockDeniedSubject.asObservable();
        this.nodeLocked$ = this.nodeLockedSubject.asObservable();
        this.nodeUnlocked$ = this.nodeUnlockedSubject.asObservable();
        this.lockState$ = this.lockStateSubject.asObservable();
        this.remoteNodeDataUpdate$ = this.remoteNodeDataUpdateSubject.asObservable();
        this.remoteNodeAdded$ = this.remoteNodeAddedSubject.asObservable();
        this.remoteNodeDeleted$ = this.remoteNodeDeletedSubject.asObservable();
        this.remoteConnectionAdded$ = this.remoteConnectionAddedSubject.asObservable();
        this.remoteConnectionRemoved$ = this.remoteConnectionRemovedSubject.asObservable();
        this.opRejected$ = this.opRejectedSubject.asObservable();
    }

    // --- Public methods ---

    connect(flowId: number): void {
        if (this.socket !== null) {
            if (this.connectedFlowId === flowId) {
                return;
            }
            this.disconnect();
        }

        this.openSocket(flowId, true);
    }

    disconnect(): void {
        this.intentionalClose = true;
        this.cancelPendingReconnect();
        this.stopHeartbeat();
        this.closeSocket();
        this.participantCount.set(0);
        this.participants.set([]);
        this.connectionState.set('disconnected');
        this.selfMemberId.set(null);
        this.isDesignated.set(false);
        this.isViewer.set(false);
        this.connectedFlowId = null;
    }

    sendNodeMove(operation: NodeMoveOp): void {
        if (this.isViewer()) {
            return;
        }
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'node_moved',
            flow_id: this.connectedFlowId,
            node_id: operation.node_id,
            x: operation.x,
            y: operation.y,
        });

        this.socket.send(message);
    }

    sendCursor(operation: CursorMoveOp): void {
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'cursor_moved',
            flow_id: this.connectedFlowId,
            x: operation.x,
            y: operation.y,
        });

        this.socket.send(message);
    }

    sendSelection(operation: SelectionOp): void {
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'selection_changed',
            flow_id: this.connectedFlowId,
            node_ids: operation.node_ids,
        });

        this.socket.send(message);
    }

    sendLockRequest(operation: LockRequestOp): void {
        if (this.isViewer()) {
            return;
        }
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'lock_request',
            flow_id: this.connectedFlowId,
            node_id: operation.node_id,
        });

        this.socket.send(message);
    }

    sendLockRelease(operation: LockReleaseOp): void {
        if (this.isViewer()) {
            return;
        }
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'lock_release',
            flow_id: this.connectedFlowId,
            node_id: operation.node_id,
        });

        this.socket.send(message);
    }

    sendNodeDataUpdate(operation: NodeDataUpdateOp): void {
        if (this.isViewer()) {
            return;
        }
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'node_data_updated',
            flow_id: this.connectedFlowId,
            node_id: operation.node_id,
            node_name: operation.node_name,
            data: operation.data,
        });

        this.socket.send(message);
    }

    sendNodeAdd(operation: NodeAddOp): void {
        if (this.isViewer()) {
            return;
        }
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'node_added',
            flow_id: this.connectedFlowId,
            node_key: operation.node_key,
            node: operation.node,
        });

        this.socket.send(message);
    }

    sendNodeDelete(operation: NodeDeleteOp): void {
        if (this.isViewer()) {
            return;
        }
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'node_deleted',
            flow_id: this.connectedFlowId,
            node_key: operation.node_key,
        });

        this.socket.send(message);
    }

    sendConnectionAdd(operation: ConnectionAddOp): void {
        if (this.isViewer()) {
            return;
        }
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'connection_added',
            flow_id: this.connectedFlowId,
            connection_id: operation.connection_id,
            source_node_key: operation.source_node_key,
            target_node_key: operation.target_node_key,
            source_port_id: operation.source_port_id,
            target_port_id: operation.target_port_id,
            connection: operation.connection,
        });

        this.socket.send(message);
    }

    sendConnectionRemove(operation: ConnectionRemoveOp): void {
        if (this.isViewer()) {
            return;
        }
        if (this.connectionState() !== 'connected' || this.socket === null || this.connectedFlowId === null) {
            return;
        }

        const message = JSON.stringify({
            type: 'connection_removed',
            flow_id: this.connectedFlowId,
            connection_id: operation.connection_id,
        });

        this.socket.send(message);
    }

    // --- Private methods ---

    /**
     * Opens a new WebSocket connection for the given flow.
     *
     * @param flowId - The flow to connect to.
     * @param allowReconnect - When true, a connection failure schedules one
     *   reconnect attempt. When false (reconnect attempt itself), failure is
     *   treated as final and no further reconnect is scheduled.
     */
    private openSocket(flowId: number, allowReconnect: boolean): void {
        const url = this.buildWebSocketUrl(flowId);
        if (url === null) {
            return;
        }

        this.intentionalClose = false;
        this.connectedFlowId = flowId;
        this.connectionState.set('connecting');
        this.selfMemberId.set(null);

        const webSocket = new WebSocket(url);
        this.socket = webSocket;

        webSocket.onopen = (): void => {
            if (this.socket === webSocket) {
                this.connectionState.set('connected');
                this.startHeartbeat();
            }
        };

        webSocket.onmessage = (event: MessageEvent): void => {
            this.handleMessage(event);
        };

        webSocket.onclose = (): void => {
            if (this.socket !== webSocket) {
                return;
            }
            this.socket = null;
            this.stopHeartbeat();

            if (this.intentionalClose) {
                return;
            }

            this.connectionState.set('disconnected');

            if (allowReconnect) {
                this.scheduleReconnect(flowId);
            } else {
                // Reconnect attempt itself failed — give up.
                this.connectedFlowId = null;
            }
        };

        webSocket.onerror = (): void => {
            // The close event fires immediately after an error, so no additional
            // state updates are needed here. The close handler drives recovery.
        };
    }

    private handleMessage(event: MessageEvent): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(event.data as string);
        } catch {
            return;
        }

        if (isHeartbeatAckMessage(parsed)) {
            // Liveness bookkeeping only — never forwarded to feature streams.
            this.lastHeartbeatAckAt = Date.now();
            return;
        }

        if (isPresenceMessage(parsed)) {
            this.participantCount.set(parsed.count);
            this.participants.set(parsed.participants ?? []);
            // Update designated-client status whenever presence changes.
            // designated_member_id is optional — absent on older servers; treat as non-designated.
            const designatedId = parsed.designated_member_id ?? null;
            this.isDesignated.set(designatedId !== null && designatedId === this.selfMemberId());
            return;
        }

        if (isFlushRequestedMessage(parsed)) {
            this.flushRequestedSubject.next(parsed);
            return;
        }

        if (isNodeMovedMessage(parsed)) {
            this.remoteNodeMoveSubject.next(parsed);
            return;
        }

        if (isDocumentStateMessage(parsed)) {
            this.documentStateSubject.next(parsed);
            return;
        }

        if (isCursorMovedMessage(parsed)) {
            this.remoteCursorSubject.next(parsed);
            return;
        }

        if (isSelectionChangedMessage(parsed)) {
            this.remoteSelectionSubject.next(parsed);
            return;
        }

        if (isSelfIdentityMessage(parsed)) {
            this.selfMemberId.set(parsed.member_id);
            this.isViewer.set(parsed.is_viewer === true);
            return;
        }

        if (isOpRejectedMessage(parsed)) {
            // This should be silent in normal operation — the UI gates all mutating ops
            // before they reach the transport. A firing event means a gate is missing.
            console.warn(
                `[CollaborationPresenceService] op_rejected received for op="${parsed.op}" — viewer gate missing for this operation`
            );
            this.opRejectedSubject.next(parsed);
            return;
        }

        if (isLockGrantedMessage(parsed)) {
            this.lockGrantedSubject.next(parsed);
            return;
        }

        if (isLockDeniedMessage(parsed)) {
            this.lockDeniedSubject.next(parsed);
            return;
        }

        if (isNodeLockedMessage(parsed)) {
            this.nodeLockedSubject.next(parsed);
            return;
        }

        if (isNodeUnlockedMessage(parsed)) {
            this.nodeUnlockedSubject.next(parsed);
            return;
        }

        if (isLockStateMessage(parsed)) {
            this.lockStateSubject.next(parsed);
            return;
        }

        if (isNodeDataUpdatedMessage(parsed)) {
            this.remoteNodeDataUpdateSubject.next(parsed);
            return;
        }

        if (isNodeAddedMessage(parsed)) {
            this.remoteNodeAddedSubject.next(parsed);
            return;
        }

        if (isNodeDeletedMessage(parsed)) {
            this.remoteNodeDeletedSubject.next(parsed);
            return;
        }

        if (isConnectionAddedMessage(parsed)) {
            this.remoteConnectionAddedSubject.next(parsed);
            return;
        }

        if (isConnectionRemovedMessage(parsed)) {
            this.remoteConnectionRemovedSubject.next(parsed);
            return;
        }
    }

    private scheduleReconnect(flowId: number): void {
        this.cancelPendingReconnect();
        this.reconnectTimerId = setTimeout(() => {
            this.reconnectTimerId = null;
            if (this.intentionalClose) {
                return;
            }
            this.openSocket(flowId, false);
        }, RECONNECT_DELAY_MS);
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        // A fresh connection starts with a clean slate so it is not immediately
        // judged stale by acks that never had a chance to arrive.
        this.lastHeartbeatAckAt = Date.now();
        this.heartbeatTimerId = setInterval(() => {
            this.onHeartbeatTick();
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimerId !== null) {
            clearInterval(this.heartbeatTimerId);
            this.heartbeatTimerId = null;
        }
        this.lastHeartbeatAckAt = null;
    }

    private onHeartbeatTick(): void {
        if (this.socket === null || this.connectedFlowId === null) {
            this.stopHeartbeat();
            return;
        }

        if (this.lastHeartbeatAckAt !== null && Date.now() - this.lastHeartbeatAckAt > HEARTBEAT_ACK_STALENESS_MS) {
            // Zombie connection: the socket looks open but acks stopped coming,
            // so either the server cannot hear us or we cannot hear it.
            this.recoverFromZombieConnection(this.connectedFlowId);
            return;
        }

        const message = JSON.stringify({
            type: 'heartbeat',
            flow_id: this.connectedFlowId,
        });

        this.socket.send(message);
    }

    private recoverFromZombieConnection(flowId: number): void {
        // closeSocket() detaches the onclose handler, so the close event will
        // not drive recovery — replicate its steps and hand off to the
        // existing reconnect path explicitly.
        this.stopHeartbeat();
        this.closeSocket();
        this.connectionState.set('disconnected');
        this.scheduleReconnect(flowId);
    }

    private closeSocket(): void {
        if (this.socket !== null) {
            this.socket.onopen = null;
            this.socket.onmessage = null;
            this.socket.onclose = null;
            this.socket.onerror = null;
            this.socket.close();
            this.socket = null;
        }
    }

    private cancelPendingReconnect(): void {
        if (this.reconnectTimerId !== null) {
            clearTimeout(this.reconnectTimerId);
            this.reconnectTimerId = null;
        }
    }

    private buildWebSocketUrl(flowId: number): string | null {
        const token = this.authService.getAccessToken();
        if (!token) {
            return null;
        }

        const realtimeBase = this.configService.realtimeApiUrl;
        const wsBase = realtimeBase.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
        const normalizedBase = wsBase.endsWith('/') ? wsBase : `${wsBase}/`;

        let url = `${normalizedBase}collab/?flow_id=${flowId}&token=${encodeURIComponent(token)}`;

        const orgId = this.activeOrgService.activeOrgId();
        if (orgId !== null) {
            url += `&org_id=${orgId}`;
        }

        return url;
    }
}
