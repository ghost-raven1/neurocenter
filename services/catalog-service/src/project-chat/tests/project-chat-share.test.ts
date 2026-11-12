import { describe, expect, it } from 'vitest';
import { PROJECT_CHAT_SHARE_ACTION, parseProjectChatShares } from '../project-chat-share';

const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';
const block = (body: string) => '```neurocenter-share\n' + body + '\n```';
const item = (body: Record<string, unknown>) => JSON.stringify(body);

describe('parseProjectChatShares', () => {
    it('exposes the audit action used by the runner', () => {
        expect(PROJECT_CHAT_SHARE_ACTION).toBe('project.chat.agent.share');
    });

    it('returns an empty list when no directive is present', () => {
        expect(parseProjectChatShares('Обычный ответ без директив.')).toEqual([]);
        expect(parseProjectChatShares('')).toEqual([]);
    });

    it('parses a valid directive', () => {
        const shares = parseProjectChatShares(
            'Работаю.\n\n' +
                block(JSON.stringify({ roomId: ROOM_A, items: [{ kind: 'decision', content: 'Решение: X' }] })),
        );
        expect(shares).toEqual([{ roomId: ROOM_A, items: [{ kind: 'decision', content: 'Решение: X' }] }]);
    });

    it('normalizes room and ref IDs to lowercase', () => {
        const shares = parseProjectChatShares(
            block(JSON.stringify({ roomId: ROOM_A.toUpperCase(), items: [{ kind: 'state', content: 's' }] })),
        );
        expect(shares[0].roomId).toBe(ROOM_A);
        const withRef = parseProjectChatShares(
            block(
                JSON.stringify({
                    roomId: ROOM_A,
                    items: [{ kind: 'result', content: 'r', ref: ROOM_B.toUpperCase() }],
                }),
            ),
        );
        expect(withRef[0].items[0].ref).toBe(ROOM_B);
    });

    it('returns every valid directive (up to four) in one answer', () => {
        const body = Array.from({ length: 5 }, (_, n) =>
            block(
                JSON.stringify({
                    roomId: ROOM_A,
                    items: [{ kind: 'state', content: 'item-' + n }],
                }),
            ),
        ).join('\n');
        expect(parseProjectChatShares(body)).toHaveLength(4);
    });

    it('skips malformed blocks without failing', () => {
        expect(parseProjectChatShares(block('не json'))).toEqual([]);
        expect(parseProjectChatShares(block(JSON.stringify([ROOM_A])))).toEqual([]);
        expect(parseProjectChatShares(block(JSON.stringify({ items: [{ kind: 'state', content: 's' }] })))).toEqual([]);
        expect(
            parseProjectChatShares(
                block(JSON.stringify({ roomId: 'not-a-uuid', items: [{ kind: 'state', content: 's' }] })),
            ),
        ).toEqual([]);
        expect(parseProjectChatShares(block(JSON.stringify({ roomId: ROOM_A, items: [] })))).toEqual([]);
        expect(
            parseProjectChatShares(
                block(
                    JSON.stringify({
                        roomId: ROOM_A,
                        items: Array.from({ length: 9 }, () => ({ kind: 'state', content: 's' })),
                    }),
                ),
            ),
        ).toEqual([]);
        expect(
            parseProjectChatShares(
                block(JSON.stringify({ roomId: ROOM_A, items: [{ kind: 'unknown', content: 's' }] })),
            ),
        ).toEqual([]);
        expect(
            parseProjectChatShares(block(JSON.stringify({ roomId: ROOM_A, items: [{ kind: 'state', content: '' }] }))),
        ).toEqual([]);
        expect(
            parseProjectChatShares(
                block(JSON.stringify({ roomId: ROOM_A, items: [{ kind: 'state', content: '   ' }] })),
            ),
        ).toEqual([]);
        expect(
            parseProjectChatShares(
                block(JSON.stringify({ roomId: ROOM_A, items: [{ kind: 'state', content: 's', ref: 'nope' }] })),
            ),
        ).toEqual([]);
        expect(
            parseProjectChatShares(
                '```neurocenter-share\n' + JSON.stringify({ roomId: ROOM_A, items: [{ kind: 'state', content: 's' }] }),
            ),
        ).toEqual([]);
    });

    it('keeps valid directives after malformed ones in the same answer', () => {
        const body =
            block('не json') +
            '\n' +
            block(JSON.stringify({ roomId: ROOM_A, items: [{ kind: 'decision', content: 'Осталось решение' }] }));
        const shares = parseProjectChatShares(body);
        expect(shares).toHaveLength(1);
        expect(shares[0].items[0].content).toBe('Осталось решение');
    });
});
