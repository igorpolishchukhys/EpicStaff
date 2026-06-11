import { TestBed } from '@angular/core/testing';

import { AuthService } from '../auth/auth.service';
import { ConfigService } from '../config/config.service';
import { FlushRequestedMessage } from './collab-message.model';
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

describe('CollaborationPresenceService — flush & designation', () => {
    let service: CollaborationPresenceService;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                CollaborationPresenceService,
                { provide: AuthService, useClass: AuthServiceStub },
                { provide: ConfigService, useClass: ConfigServiceStub },
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
