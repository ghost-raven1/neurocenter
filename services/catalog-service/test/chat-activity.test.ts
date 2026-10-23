import {describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {chatActivityMessageIds, chatActivitySession, chatActivityWatch} from '../src/chat-activity/chat-activity.validation';

describe('Chat activity accepts only an ordered tab identity and explicit visible message IDs', () => {
    const sessionId = randomUUID(), messageId = randomUUID(), body = {sessionId, sequence: 1, online: true};
    it('separates account presence from room typing and a bounded visible batch', () => {
        expect(chatActivitySession(body)).toMatchObject(body);
        expect(chatActivitySession({...body, typing: true, visibleMessageIds: [messageId]}, true)).toMatchObject({typing: true, visibleMessageIds: [messageId]});
        expect(chatActivityWatch(messageId)).toEqual([messageId]);
        expect(chatActivityWatch()).toEqual([]);
        expect(chatActivityMessageIds([])).toEqual([]);
    });
    it.each([{sequence: 0}, {sequence: -1}, {sequence: Number.MAX_SAFE_INTEGER + 1}, {sequence: '1'}, {online: 1}, {sessionId: 'bad'}, {actorEmail: 'spoof@test.invalid'}])('rejects invalid session identity %j', patch => {
        expect(() => chatActivitySession({...body, ...patch}, true)).toThrow();
    });
    it('cleanup cannot smuggle a new typing state or receipt after flags are off', () => {
        expect(chatActivitySession({...body, online: false}, true)).toMatchObject({online: false, typing: false, visibleMessageIds: []});
        expect(() => chatActivitySession({...body, online: false, typing: true}, true)).toThrow();
        expect(() => chatActivitySession({...body, online: false, visibleMessageIds: [messageId]}, true)).toThrow();
    });
    it('global heartbeat does not accept project typing or receipts', () => {
        expect(() => chatActivitySession({...body, typing: true})).toThrow();
        expect(() => chatActivitySession({...body, visibleMessageIds: [messageId]})).toThrow();
    });
    it.each(['', 'bad', [messageId], [messageId, messageId].join(','), Array.from({length: 101}, () => randomUUID()).join(',')])('rejects malformed or unbounded receipt polling %j', value => {
        expect(() => chatActivityWatch(value as string)).toThrow();
    });
    it.each([null, 'all', [messageId, messageId], Array.from({length: 101}, () => randomUUID())])('rejects malformed or unbounded visible batch %j', value => {
        expect(() => chatActivitySession({...body, visibleMessageIds: value}, true)).toThrow();
    });
});
