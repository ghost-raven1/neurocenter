import { describe, expect, it } from 'vitest';
import { discussionResponses } from '../src/model-chat/chat-discussion.repository';
import { unknownGroupUsage } from '../src/model-chat/chat-group.types';
import type { DiscussionRun, DiscussionStep } from '../src/model-chat/chat-discussion.types';
import type { TurnRow } from '../src/model-chat/chat.types';

const turn = { id: 'turn', status: 'done', answer: { content: 'Сохранённый итог', finishReason: 'stop', usage: unknownGroupUsage() } } as TurnRow;
const run = { model: { id: 'model', name: 'Model' } } as DiscussionRun;
const response = (agentId: string, status: 'done' | 'failed' = 'done', phase: 'response' | 'critique' = 'response'): DiscussionStep => ({
    id: agentId + ':' + phase, snapshot: { agentId, name: agentId, slug: agentId }, phase, status,
    output: status === 'done' ? 'Ответ ' + agentId : null, error: status === 'failed' ? 'Модель недоступна' : null,
    model_id: 'model', model_pin: 'a'.repeat(64), finish_reason: status === 'done' ? 'stop' : null,
} as DiscussionStep);

describe('Durable discussion summary presentation policy', () => {
    it.each([undefined, 'legacy'] as const)('preserves an existing singleton summary under policy %s', policy => {
        expect(discussionResponses(turn, { ...run, summary_policy: policy }, [response('agent-a')]).map(item => item.agentId))
            .toEqual(['agent-a', 'discussion-summary']);
    });
    it.each([
        [], [response('agent-a')], [response('agent-a'), response('agent-b', 'failed')],
        [response('agent-a'), response('agent-a', 'done', 'critique')],
    ].map(steps => [steps]))('does not append a summary without two actual unique responders', input => {
        const rendered = discussionResponses(turn, { ...run, summary_policy: 'unique-v1' }, input);
        expect(rendered).toHaveLength(input.length); expect(rendered.some(item => item.agentId === 'discussion-summary')).toBe(false);
        expect(rendered.filter(item => item.status === 'failed').map(item => item.error)).toEqual(input.filter(item => item.status === 'failed').map(item => item.error));
    });
    it('keeps individual answers and adds the saved common summary after two actual successes', () => {
        const rendered = discussionResponses(turn, { ...run, summary_policy: 'unique-v1' }, [response('agent-a'), response('agent-b')]);
        expect(rendered.map(item => item.agentId)).toEqual(['agent-a', 'agent-b', 'discussion-summary']);
        expect(rendered.at(-1)?.answer).toEqual(turn.answer);
    });
});
