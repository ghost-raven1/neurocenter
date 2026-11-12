import { describe, expect, it } from 'vitest';
import { PROJECT_CHAT_HANDOVER_ACTION, parseProjectChatHandover } from '../project-chat-handover';

// Platform agent ids carry the stable "agent-" prefix (see agent.repository).
const AGENT_A = 'agent-11111111-1111-4111-8111-111111111111';
const AGENT_B = 'agent-22222222-2222-4222-8222-222222222222';
const block = (body: string) => '```neurocenter-handover\n' + body + '\n```';

describe('parseProjectChatHandover', () => {
    it('exposes the audit action used by the runner and the agent journal', () => {
        expect(PROJECT_CHAT_HANDOVER_ACTION).toBe('project.chat.agent.handover');
    });

    it('returns null when no directive is present', () => {
        expect(parseProjectChatHandover('Обычный ответ без директив.')).toBeNull();
        expect(parseProjectChatHandover('')).toBeNull();
    });

    it('parses a valid directive', () => {
        expect(
            parseProjectChatHandover(
                'Работаю.\n\n' + block(JSON.stringify({ agentId: AGENT_B, note: 'Нужна экспертиза' })),
            ),
        ).toEqual({
            agentId: AGENT_B,
            note: 'Нужна экспертиза',
        });
    });

    it('normalizes the agent id and treats a missing note as empty', () => {
        expect(parseProjectChatHandover(block(JSON.stringify({ agentId: AGENT_B.toUpperCase() })))).toEqual({
            agentId: AGENT_B,
            note: '',
        });
    });

    it('caps the note length', () => {
        const parsed = parseProjectChatHandover(block(JSON.stringify({ agentId: AGENT_B, note: 'y'.repeat(5000) })));
        expect(parsed?.note).toHaveLength(2000);
    });

    it('ignores malformed blocks without failing', () => {
        expect(parseProjectChatHandover(block('не json'))).toBeNull();
        expect(parseProjectChatHandover(block(JSON.stringify([AGENT_B])))).toBeNull();
        expect(parseProjectChatHandover(block(JSON.stringify({ agentId: 'not-a-uuid' })))).toBeNull();
        // A bare UUID without the platform "agent-" prefix is not a valid agent id.
        expect(
            parseProjectChatHandover(block(JSON.stringify({ agentId: '22222222-2222-4222-8222-222222222222' }))),
        ).toBeNull();
        expect(parseProjectChatHandover(block(JSON.stringify({ agentId: AGENT_B, note: 42 })))).toBeNull();
        expect(parseProjectChatHandover('```neurocenter-handover\n' + JSON.stringify({ agentId: AGENT_B }))).toBeNull();
    });

    it('keeps the first valid directive when several blocks are present', () => {
        const other = '33333333-3333-4333-8333-333333333333';
        const content =
            block(JSON.stringify({ agentId: 'bad' })) +
            '\n\n' +
            block(JSON.stringify({ agentId: AGENT_B, note: 'first valid' })) +
            '\n\n' +
            block(JSON.stringify({ agentId: other }));
        expect(parseProjectChatHandover(content)).toEqual({ agentId: AGENT_B, note: 'first valid' });
    });

    it('does not treat a similarly named fence as a directive', () => {
        expect(parseProjectChatHandover('```neurocenter-handover-x\n{"agentId":"' + AGENT_B + '"}\n```')).toBeNull();
    });
});
