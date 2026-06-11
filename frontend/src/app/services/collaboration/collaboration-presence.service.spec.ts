import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ActiveOrgService } from '../auth/active-org.service';
import { AuthService } from '../auth/auth.service';
import { ConfigService } from '../config/config.service';
import { FlushRequestedMessage, OpRejectedMessage } from './collab-message.model';
import { CollaborationPresenceService } from './collaboration-presence.service';

/** Minimal stub that satisfies the parts of AuthService used by the WS builder. */
class AuthServiceStub {
    getAccessToken(): string {
        return 'test-token';
    }
}

/** Minimal stub that satisfies the parts of ConfigService used by the WS builder. */
class ConfigServiceStub {
    readonly realtimeApiUrl = 'http://localhost:8001';
}

/** Minimal stub for ActiveOrgService. */
class ActiveOrgServiceStub {
    readonly activeOrgId = signal<number | null>(null);
}

describe('CollaborationPresenceService — flush & designation', () => {
    let service: CollaborationPresenceService;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                CollaborationPresenceService,
                { provide: AuthService, useClass: AuthServiceStub },
                { provide: ConfigService, useClass: ConfigServiceStub },
                { provide: ActiveOrgService, useClass: ActiveOrgServiceStub },
            ],
        });
        service = TestBed.inject(CollaborationPresenceService);
    });

    describe('flushRequested$', () => {
        it('emits when a flush_requested frame is dispatched via handleMessage', () => {
            const emitted: FlushRequestedMessage[] = [];
            service.flushRequested$.subscribe((msg) => emitted.push(msg));

            // Access private handleMessage via the MessageEvent path through a real WS
            // is impractical in unit tests; instead we expose the internal subject via
            // the public observable and call handleMessage directly via casting.
            const frame: FlushRequestedMessage = {
                type: 'flush_requested',
                flow_id: 5,
                reason: 'periodic',
            };

            // Simulate a MessageEvent arriving on the socket by calling the private
            // handler directly.
            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', { data: JSON.stringify(frame) })
            );

            expect(emitted.length).toBe(1);
            expect(emitted[0].flow_id).toBe(5);
            expect(emitted[0].reason).toBe('periodic');
        });

        it('does not emit for unrelated frame types', () => {
            const emitted: FlushRequestedMessage[] = [];
            service.flushRequested$.subscribe((msg) => emitted.push(msg));

            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({ type: 'heartbeat_ack', flow_id: 5 }),
                })
            );

            expect(emitted.length).toBe(0);
        });
    });

    describe('isDesignated signal', () => {
        it('starts as false', () => {
            expect(service.isDesignated()).toBeFalse();
        });

        it('becomes true when a presence frame designates this client', () => {
            // First set selfMemberId (simulated by the self frame).
            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'self',
                        flow_id: 1,
                        member_id: 'member-alpha',
                        user_id: 99,
                    }),
                })
            );
            expect(service.selfMemberId()).toBe('member-alpha');

            // Now receive a presence frame designating this member.
            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'presence',
                        flow_id: 1,
                        count: 2,
                        designated_member_id: 'member-alpha',
                    }),
                })
            );

            expect(service.isDesignated()).toBeTrue();
        });

        it('becomes false when a different member is designated', () => {
            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'self',
                        flow_id: 1,
                        member_id: 'member-alpha',
                        user_id: 99,
                    }),
                })
            );

            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'presence',
                        flow_id: 1,
                        count: 2,
                        designated_member_id: 'member-beta',
                    }),
                })
            );

            expect(service.isDesignated()).toBeFalse();
        });

        it('remains false when designated_member_id is null (older servers)', () => {
            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'self',
                        flow_id: 1,
                        member_id: 'member-alpha',
                        user_id: 99,
                    }),
                })
            );

            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'presence',
                        flow_id: 1,
                        count: 1,
                        designated_member_id: null,
                    }),
                })
            );

            expect(service.isDesignated()).toBeFalse();
        });

        it('remains false when designated_member_id is absent (older servers)', () => {
            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'self',
                        flow_id: 1,
                        member_id: 'member-alpha',
                        user_id: 99,
                    }),
                })
            );

            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'presence',
                        flow_id: 1,
                        count: 1,
                    }),
                })
            );

            expect(service.isDesignated()).toBeFalse();
        });

        it('resets to false on disconnect()', () => {
            // Force isDesignated to true first.
            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({ type: 'self', flow_id: 1, member_id: 'mx', user_id: 1 }),
                })
            );
            (service as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
                new MessageEvent('message', {
                    data: JSON.stringify({
                        type: 'presence',
                        flow_id: 1,
                        count: 1,
                        designated_member_id: 'mx',
                    }),
                })
            );
            expect(service.isDesignated()).toBeTrue();

            service.disconnect();

            expect(service.isDesignated()).toBeFalse();
        });
    });
});

describe('CollaborationPresenceService — isViewer', () => {
    let service: CollaborationPresenceService;

    const simulateMessage = (svc: CollaborationPresenceService, data: unknown): void => {
        (svc as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
            new MessageEvent('message', { data: JSON.stringify(data) })
        );
    };

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                CollaborationPresenceService,
                { provide: AuthService, useClass: AuthServiceStub },
                { provide: ConfigService, useClass: ConfigServiceStub },
                { provide: ActiveOrgService, useClass: ActiveOrgServiceStub },
            ],
        });
        service = TestBed.inject(CollaborationPresenceService);
    });

    it('starts as false', () => {
        expect(service.isViewer()).toBeFalse();
    });

    it('becomes true when self frame carries is_viewer: true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        expect(service.isViewer()).toBeTrue();
    });

    it('remains false when self frame carries is_viewer: false', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: false });
        expect(service.isViewer()).toBeFalse();
    });

    it('remains false when self frame omits is_viewer (older servers)', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1 });
        expect(service.isViewer()).toBeFalse();
    });

    it('resets to false on disconnect()', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        expect(service.isViewer()).toBeTrue();

        service.disconnect();

        expect(service.isViewer()).toBeFalse();
    });
});

describe('CollaborationPresenceService — mutating send* guards', () => {
    let service: CollaborationPresenceService;

    const simulateMessage = (svc: CollaborationPresenceService, data: unknown): void => {
        (svc as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
            new MessageEvent('message', { data: JSON.stringify(data) })
        );
    };

    /** Simulate a connected socket (enough for send checks without a real WS server). */
    const simulateConnected = (svc: CollaborationPresenceService): void => {
        // Reach into private state to satisfy the connection guard without opening a real socket.
        (svc as unknown as { connectionState: { set(v: string): void } }).connectionState.set('connected');
        (svc as unknown as { connectedFlowId: number }).connectedFlowId = 1;
        (svc as unknown as { socket: { send(d: string): void } | null }).socket = { send: jasmine.createSpy('send') };
    };

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                CollaborationPresenceService,
                { provide: AuthService, useClass: AuthServiceStub },
                { provide: ConfigService, useClass: ConfigServiceStub },
                { provide: ActiveOrgService, useClass: ActiveOrgServiceStub },
            ],
        });
        service = TestBed.inject(CollaborationPresenceService);
        simulateConnected(service);
    });

    it('sendNodeMove is a no-op when isViewer is true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendNodeMove({ node_id: 1, x: 10, y: 20 });
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sendNodeAdd is a no-op when isViewer is true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendNodeAdd({ node_key: 'nk', node: {} });
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sendNodeDelete is a no-op when isViewer is true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendNodeDelete({ node_key: 'nk' });
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sendConnectionAdd is a no-op when isViewer is true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendConnectionAdd({
            connection_id: 'c1',
            source_node_key: 'a',
            target_node_key: 'b',
            source_port_id: 'p1',
            target_port_id: 'p2',
            connection: {},
        });
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sendConnectionRemove is a no-op when isViewer is true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendConnectionRemove({ connection_id: 'c1' });
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sendNodeDataUpdate is a no-op when isViewer is true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendNodeDataUpdate({ node_id: 1, node_name: 'n', data: {} });
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sendLockRequest is a no-op when isViewer is true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendLockRequest({ node_id: 1 });
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sendLockRelease is a no-op when isViewer is true', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendLockRelease({ node_id: 1 });
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sendCursor is NOT blocked when isViewer is true (cursor still allowed)', () => {
        simulateMessage(service, { type: 'self', flow_id: 1, member_id: 'mx', user_id: 1, is_viewer: true });
        const socket = (service as unknown as { socket: { send: jasmine.Spy } }).socket!;
        service.sendCursor({ x: 5, y: 5 });
        expect(socket.send).toHaveBeenCalled();
    });
});

describe('CollaborationPresenceService — op_rejected handling', () => {
    let service: CollaborationPresenceService;

    const simulateMessage = (svc: CollaborationPresenceService, data: unknown): void => {
        (svc as unknown as { handleMessage(e: MessageEvent): void }).handleMessage(
            new MessageEvent('message', { data: JSON.stringify(data) })
        );
    };

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                CollaborationPresenceService,
                { provide: AuthService, useClass: AuthServiceStub },
                { provide: ConfigService, useClass: ConfigServiceStub },
                { provide: ActiveOrgService, useClass: ActiveOrgServiceStub },
            ],
        });
        service = TestBed.inject(CollaborationPresenceService);
    });

    it('emits on opRejected$ when an op_rejected frame arrives', () => {
        const emitted: OpRejectedMessage[] = [];
        service.opRejected$.subscribe((msg) => emitted.push(msg));

        const frame: OpRejectedMessage = { type: 'op_rejected', flow_id: 1, op: 'node_moved', reason: 'viewer' };
        simulateMessage(service, frame);

        expect(emitted.length).toBe(1);
        expect(emitted[0].op).toBe('node_moved');
    });

    it('does not emit on opRejected$ for unrelated frames', () => {
        const emitted: OpRejectedMessage[] = [];
        service.opRejected$.subscribe((msg) => emitted.push(msg));

        simulateMessage(service, { type: 'heartbeat_ack', flow_id: 1 });

        expect(emitted.length).toBe(0);
    });
});
