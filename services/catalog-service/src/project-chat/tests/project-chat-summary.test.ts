import { describe, expect, it } from 'vitest';
import type { IChatAgentSnapshot } from '../../model-chat/chat-group.interfaces';
import type { IProjectChatMessageRow } from '../project-chat.interfaces';
import { projectChatSummary } from '../project-chat.runner';

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;

const snapshot = (agentId: string, name: string, slug: string): IChatAgentSnapshot => ({
    agentId,
    name,
    slug,
    version: 1,
    manifest: 'b'.repeat(64),
    definition: { description: 'Специалист', prompt: 'PRIVATE PERSONA', mode: 'all', permission: {} },
    modelId: 'model-qa',
    modelName: 'QA model',
    modelPin: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
});
const row = (overrides: Partial<IProjectChatMessageRow> = {}): IProjectChatMessageRow => ({
    id: id('message'),
    project_id: 'prj-qa',
    position: String(++counter),
    kind: 'agent',
    content: 'Ответ',
    author_email: null,
    author_name: null,
    author_role: null,
    reply_to_id: null,
    source_message_id: id('source'),
    status: 'done',
    request_key: null,
    request_hash: null,
    target_agent_ids: [],
    snapshot: snapshot('agent-a', 'Альфа', 'alfa'),
    generation: id('generation'),
    lease_until: null,
    error: null,
    usage: null,
    learning: null,
    created_at: '2026-11-12T00:00:00.000Z',
    ...overrides,
});
const source = row({ kind: 'user', content: 'Вопрос', snapshot: null });

describe('FR-303 summary: only after several UNIQUE agents', () => {
    it('no summary without answers or with a single agent', () => {
        expect(projectChatSummary(source, [])).toBe('');
        expect(projectChatSummary(source, [row()])).toBe('');
    });

    it('repeats of the same agent are not unique: two done answers of one agent → no summary', () => {
        const first = row({ generation: id('generation') });
        const repeat = row({ generation: id('generation') });
        expect(projectChatSummary(source, [first, repeat])).toBe('');
    });

    it('two unique agents produce the summary with both contributions and links', () => {
        const alpha = row();
        const beta = row({ snapshot: snapshot('agent-b', 'Бета', 'beta') });
        const summary = projectChatSummary(source, [alpha, beta]);
        expect(summary).toContain('## Итог по вопросу');
        expect(summary).toContain(`(#project-chat-message-${source.id})`);
        expect(summary).toContain('### Альфа (@alfa)');
        expect(summary).toContain('### Бета (@beta)');
        expect(summary).toContain(`[Полный ответ агента](#project-chat-message-${alpha.id})`);
        expect(summary).toContain(`[Полный ответ агента](#project-chat-message-${beta.id})`);
    });

    it('ignores non-done answers, failed attempts and non-agent rows', () => {
        const alpha = row();
        const failed = row({
            snapshot: snapshot('agent-b', 'Бета', 'beta'),
            status: 'failed',
            error: 'модель недоступна',
        });
        const running = row({ snapshot: snapshot('agent-c', 'Гамма', 'gamma'), status: 'running' });
        expect(projectChatSummary(source, [alpha, failed, running])).toBe('');
        const beta = row({ snapshot: snapshot('agent-b', 'Бета', 'beta') });
        expect(projectChatSummary(source, [alpha, failed, running, beta])).toContain('### Бета (@beta)');
    });

    it('truncates long answers and keeps the pointer to the full message', () => {
        const alpha = row({ content: 'x'.repeat(5000) });
        const beta = row({ snapshot: snapshot('agent-b', 'Бета', 'beta') });
        const summary = projectChatSummary(source, [alpha, beta]);
        expect(summary).toContain('x'.repeat(4000));
        expect(summary).toContain('Полный ответ — в сообщении выше.');
        expect(summary).not.toContain('x'.repeat(4001));
    });
});
