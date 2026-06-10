import { inject, Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { AuthService } from '../auth/auth.service';
import { ConfigService } from '../config/config.service';
import {
    CollabConnectionState,
    CursorMovedMessage,
    CursorMoveOp,
    DocumentStateMessage,
    isCursorMovedMessage,
    isDocumentStateMessage,
    isNodeMovedMessage,
    isPresenceMessage,
    isSelectionChangedMessage,
    isSelfIdentityMessage,
    NodeMovedMessage,
    NodeMoveOp,
    PresenceParticipant,
    SelectionChangedMessage,
    SelectionOp,
} from './collab-message.model';

const RECONNECT_DELAY_MS = 3_000;

@Injectable({ providedIn: 'root' })
export class CollaborationPresenceService {
    // --- Signals ---
    readonly participantCount = signal<number>(0);
    readonly participants = signal<PresenceParticipant[]>([]);
    readonly connectionState = signal<CollabConnectionState>('disconnected');
    readonly selfMemberId = signal<string | null>(null);

    // --- Observables ---
    readonly remoteNodeMove$: Observable<NodeMovedMessage>;
    readonly documentState$: Observable<DocumentStateMessage>;
    readonly remoteCursor$: Observable<CursorMovedMessage>;
    readonly remoteSelection$: Observable<SelectionChangedMessage>;

    // --- Private fields ---
    private readonly authService = inject(AuthService);
    private readonly configService = inject(ConfigService);

    private readonly remoteNodeMoveSubject = new Subject<NodeMovedMessage>();
    private readonly documentStateSubject = new Subject<DocumentStateMessage>();
    private readonly remoteCursorSubject = new Subject<CursorMovedMessage>();
    private readonly remoteSelectionSubject = new Subject<SelectionChangedMessage>();

    private socket: WebSocket | null = null;
    private connectedFlowId: number | null = null;
    private intentionalClose = false;
    private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.remoteNodeMove$ = this.remoteNodeMoveSubject.asObservable();
        this.documentState$ = this.documentStateSubject.asObservable();
        this.remoteCursor$ = this.remoteCursorSubject.asObservable();
        this.remoteSelection$ = this.remoteSelectionSubject.asObservable();
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
        this.closeSocket();
        this.participantCount.set(0);
        this.participants.set([]);
        this.connectionState.set('disconnected');
        this.selfMemberId.set(null);
        this.connectedFlowId = null;
    }

    sendNodeMove(operation: NodeMoveOp): void {
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

        if (isPresenceMessage(parsed)) {
            this.participantCount.set(parsed.count);
            this.participants.set(parsed.participants ?? []);
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

        return `${normalizedBase}collab/?flow_id=${flowId}&token=${encodeURIComponent(token)}`;
    }
}
