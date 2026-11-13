import { describe, expect, it } from 'vitest';
import {
    PROJECT_CHAT_SYSTEM_CALL_ACTION,
    PROJECT_CHAT_SYSTEM_CALL_BLOCK,
    parseProjectChatSystemCall,
} from '../project-chat-system-call';

const ROLE = 'system-role-11111111-1111-4111-8111-111111111111';
const block = (body: string) => '```' + PROJECT_CHAT_SYSTEM_CALL_BLOCK + '\n' + body + '\n```';

describe('parseProjectChatSystemCall', () => {
    it('exposes the audit action used by the runner and the agent journal', () => {
        expect(PROJECT_CHAT_SYSTEM_CALL_ACTION).toBe('project.chat.agent.system-call');
    });

    it('returns null when no directive is present', () => {
        expect(parseProjectChatSystemCall('Обычный ответ без директив.')).toBeNull();
        expect(parseProjectChatSystemCall('')).toBeNull();
    });

    it.each(['problem', 'clarification', 'recovery'])('parses a valid %s directive', (reason) => {
        expect(
            parseProjectChatSystemCall(
                'Затык.\n\n' +
                    block(JSON.stringify({ roleId: ROLE, reason, question: 'Помогите разобраться с падением' })),
            ),
        ).toEqual({ roleId: ROLE, reason, question: 'Помогите разобраться с падением' });
    });

    it('requires the exact key set', () => {
        expect(
            parseProjectChatSystemCall(
                block(JSON.stringify({ roleId: ROLE, reason: 'problem', question: 'q', extra: true })),
            ),
        ).toBeNull();
        expect(parseProjectChatSystemCall(block(JSON.stringify({ roleId: ROLE, reason: 'problem' })))).toBeNull();
        expect(parseProjectChatSystemCall(block(JSON.stringify({ reason: 'problem', question: 'q' })))).toBeNull();
    });

    it('rejects an unknown reason', () => {
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: ROLE, reason: 'panic', question: 'q' }))),
        ).toBeNull();
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: ROLE, reason: 42, question: 'q' }))),
        ).toBeNull();
    });

    it('rejects an invalid role id', () => {
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: '', reason: 'problem', question: 'q' }))),
        ).toBeNull();
        expect(
            parseProjectChatSystemCall(
                block(JSON.stringify({ roleId: 'x'.repeat(201), reason: 'problem', question: 'q' })),
            ),
        ).toBeNull();
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: 'a\\nb', reason: 'problem', question: 'q' }))),
        ).toBeNull();
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: 42, reason: 'problem', question: 'q' }))),
        ).toBeNull();
    });

    it('measures the question in bytes and rejects empty or NUL-filled text', () => {
        // 1024 Cyrillic characters are exactly 2048 UTF-8 bytes: still valid.
        const twoBytes = 'я'.repeat(1024);
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: ROLE, reason: 'problem', question: twoBytes }))),
        ).toEqual({ roleId: ROLE, reason: 'problem', question: twoBytes });
        expect(
            parseProjectChatSystemCall(
                block(JSON.stringify({ roleId: ROLE, reason: 'problem', question: twoBytes + 'я' })),
            ),
        ).toBeNull();
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: ROLE, reason: 'problem', question: '   ' }))),
        ).toBeNull();
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: ROLE, reason: 'problem', question: 'a\0b' }))),
        ).toBeNull();
        expect(
            parseProjectChatSystemCall(block(JSON.stringify({ roleId: ROLE, reason: 'problem', question: 42 }))),
        ).toBeNull();
    });

    it('ignores malformed blocks without failing the published answer', () => {
        expect(parseProjectChatSystemCall(block('не json'))).toBeNull();
        expect(parseProjectChatSystemCall(block(JSON.stringify([ROLE])))).toBeNull();
        expect(parseProjectChatSystemCall(block(JSON.stringify('str')))).toBeNull();
        // An unterminated fence is not a directive.
        expect(
            parseProjectChatSystemCall(
                '```' + PROJECT_CHAT_SYSTEM_CALL_BLOCK + '\n' + JSON.stringify({ roleId: ROLE }),
            ),
        ).toBeNull();
        // A different fenced block is not ours.
        expect(parseProjectChatSystemCall('```neurocenter-handover\n{}\n```')).toBeNull();
    });

    it('keeps the first valid directive when several blocks are present', () => {
        const other = 'system-role-22222222-2222-4222-8222-222222222222';
        const content =
            block('bad json') +
            '\n\n' +
            block(JSON.stringify({ roleId: ROLE, reason: 'clarification', question: 'first valid' })) +
            '\n\n' +
            block(JSON.stringify({ roleId: other, reason: 'recovery', question: 'second' }));
        expect(parseProjectChatSystemCall(content)).toEqual({
            roleId: ROLE,
            reason: 'clarification',
            question: 'first valid',
        });
    });

    it('accepts CRLF fenced blocks', () => {
        expect(
            parseProjectChatSystemCall(
                '```' +
                    PROJECT_CHAT_SYSTEM_CALL_BLOCK +
                    '\r\n' +
                    JSON.stringify({ roleId: ROLE, reason: 'problem', question: 'q' }) +
                    '\r\n```',
            ),
        ).toEqual({ roleId: ROLE, reason: 'problem', question: 'q' });
    });
});
