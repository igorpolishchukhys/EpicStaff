import {
    FlushRequestedMessage,
    isFlushRequestedMessage,
    isPresenceMessage,
    PresenceMessage,
} from './collab-message.model';

describe('isFlushRequestedMessage', () => {
    it('returns true for a valid flush_requested frame', () => {
        const frame: FlushRequestedMessage = {
            type: 'flush_requested',
            flow_id: 42,
            reason: 'periodic',
        };
        expect(isFlushRequestedMessage(frame)).toBeTrue();
    });

    it('returns false when type is wrong', () => {
        expect(isFlushRequestedMessage({ type: 'presence', flow_id: 42, reason: 'periodic' })).toBeFalse();
    });

    it('returns false when flow_id is missing', () => {
        expect(isFlushRequestedMessage({ type: 'flush_requested', reason: 'periodic' })).toBeFalse();
    });

    it('returns false when reason is missing', () => {
        expect(isFlushRequestedMessage({ type: 'flush_requested', flow_id: 42 })).toBeFalse();
    });

    it('returns false for null', () => {
        expect(isFlushRequestedMessage(null)).toBeFalse();
    });

    it('returns false for a non-object', () => {
        expect(isFlushRequestedMessage('flush_requested')).toBeFalse();
    });

    it('returns false when flow_id is a string instead of number', () => {
        expect(isFlushRequestedMessage({ type: 'flush_requested', flow_id: '42', reason: 'periodic' })).toBeFalse();
    });

    it('returns false when reason is a number instead of string', () => {
        expect(isFlushRequestedMessage({ type: 'flush_requested', flow_id: 42, reason: 1 })).toBeFalse();
    });
});

describe('PresenceMessage — designated_member_id field', () => {
    it('isPresenceMessage accepts a presence frame with designated_member_id present', () => {
        const frame: PresenceMessage = {
            type: 'presence',
            flow_id: 1,
            count: 2,
            designated_member_id: 'member-abc',
        };
        expect(isPresenceMessage(frame)).toBeTrue();
    });

    it('isPresenceMessage accepts a presence frame without designated_member_id (older servers)', () => {
        const frame: PresenceMessage = {
            type: 'presence',
            flow_id: 1,
            count: 1,
        };
        expect(isPresenceMessage(frame)).toBeTrue();
    });

    it('isPresenceMessage accepts a presence frame with designated_member_id: null', () => {
        const frame: PresenceMessage = {
            type: 'presence',
            flow_id: 1,
            count: 0,
            designated_member_id: null,
        };
        expect(isPresenceMessage(frame)).toBeTrue();
    });
});
