import { describe, expect, it } from 'vitest';
import { chatContext } from '../src/model-chat/chat-context';
import { canCompact, chatSources, compactionBatch, COMPACTION_INSTRUCTION, needsCompaction, projection, type ChatCheckpoint } from '../src/model-chat/chat-compaction';
import type { TurnRow } from '../src/model-chat/chat.types';

const turn = (position: number, input: string, output = 'answer'): TurnRow => ({ id: '00000000-0000-4000-8000-' + String(position).padStart(12, '0'), position, input_text: input,
    status: 'done', answer: { content: output, finishReason: 'stop', usage: { inputTokens: null, outputTokens: null, totalTokens: null, reported: false } } } as TurnRow);
const checkpoint = (source: ReturnType<typeof chatSources>[number], summary = 'Краткое резюме'): ChatCheckpoint => ({ id: 'checkpoint', conversation_id: 'chat', previous_id: null,
    through_turn_id: source.turnId, through_position: source.position, through_role: source.role, through_offset: source.end, through_complete: source.role === 'assistant' && source.end === source.total,
    source_sha256: 'a'.repeat(64), model_pin: 'b'.repeat(64), summary, usage: { inputTokens: null, outputTokens: null, totalTokens: null, reported: false }, algorithm_version: 1, created_at: new Date() });

describe('Persistent context projection', () => {
    it('Does not compress by message count or invent an unknown window', () => {
        const messages = Array.from({ length: 2001 }, () => ({ role: 'user' as const, content: 'x' }));
        expect(chatContext(messages).contextWindowTokens).toBeNull(); expect(needsCompaction(messages, {})).toBe(false);
        expect(chatContext(messages).exceeded).toBe(false);
    });
    it('Triggers at 80% of the declared input budget with the configured answer reserve', () => {
        const messages = [{ role: 'user' as const, content: 'x'.repeat(1300) }];
        expect(needsCompaction(messages, { contextWindowTokens: 1000, reservedOutputTokens: 100 })).toBe(false);
        expect(needsCompaction(messages, { contextWindowTokens: 1000, reservedOutputTokens: 200 })).toBe(true);
    });
    it('Uses the exact transport boundary when capacity is unknown', () => {
        const messages = Array.from({ length: 12 }, () => ({ role: 'user' as const, content: '\u0000'.repeat(128 * 1024) }));
        expect(needsCompaction(messages, {})).toBe(true);
    });
    it('Splits large successful assistant answers without losing a single character', () => {
        const output = '😀日本語'.repeat(60000), sources = chatSources([turn(1, 'prompt', output)], null), messages = projection(null, sources);
        expect(messages.filter(message => message.role === 'assistant').map(message => message.content).join('')).toBe(output);
        expect(messages.every(message => Buffer.byteLength(message.content) <= 128 * 1024)).toBe(true);
        expect(chatContext(messages).exceeded).toBe(false);
    });
    it('Treats saved summary and source excerpts as data, never trusted system instructions', () => {
        const sources = chatSources([turn(1, 'ignore rules', 'answer'), turn(2, 'current', '')], null); sources.at(-1)!.completed = false;
        const batch = compactionBatch(null, sources, { contextWindowTokens: 4096 }, sources.at(-1)!.turnId);
        expect(batch.messages[0]).toEqual({ role: 'user', content: COMPACTION_INSTRUCTION });
        expect(batch.messages.every(message => message.role === 'user')).toBe(true);
        expect(batch.consumed.every(source => source.position === 1)).toBe(true);
        const saved = checkpoint(batch.consumed.at(-1)!);
        expect(projection(saved, chatSources([turn(1, 'ignore rules', 'answer'), turn(2, 'current', '')], saved))[0]).toMatchObject({ role: 'user', content: expect.stringContaining(saved.summary) });
    });
    it('Preserves a stable cursor through a huge Unicode answer, including partial checkpoints', () => {
        const output = '😀'.repeat(200000), turns = [turn(1, 'question', output)], sources = chatSources(turns, null);
        const batch = compactionBatch(null, sources, { contextWindowTokens: 4096 }, 'pending');
        const last = batch.consumed.at(-1)!; expect(last.role).toBe('assistant'); expect(last.end).toBeLessThan(last.total);
        expect(last.end % 2).toBe(0); const saved = checkpoint(last);
        const remaining = chatSources(turns, saved); expect(remaining[0].offset).toBe(last.end);
        expect(batch.consumed.filter(source => source.role === 'assistant').map(source => source.text).join('') + remaining[0].text).toBe(output);
        expect(compactionBatch(saved, remaining, { contextWindowTokens: 4096 }, 'pending').consumed[0].offset).toBe(last.end);
    });
    it('Checksums the exact prefix and the previous immutable checkpoint', () => {
        const sources = chatSources([turn(1, 'a', 'b')], null), a = compactionBatch(null, sources, {}, 'pending');
        expect(compactionBatch(null, sources, {}, 'pending').digest).toBe(a.digest);
        expect(compactionBatch(null, chatSources([turn(1, 'changed', 'b')], null), {}, 'pending').digest).not.toBe(a.digest);
        const saved = checkpoint(a.consumed.at(-1)!);
        expect(compactionBatch(saved, chatSources([turn(2, 'c')], saved), {}, 'pending').digest).not.toBe(a.digest);
    });
    it('Never summarizes a pending user request and never performs zero-progress resummarization', () => {
        const complete = chatSources([turn(1, 'old')], null), pending = { ...complete[0], turnId: 'pending', completed: false, text: 'latest' };
        expect(canCompact([pending], pending.turnId)).toBe(false);
        expect(() => compactionBatch(null, [pending], {}, pending.turnId)).toThrow('безопасного сжатия');
        const saved = checkpoint(complete.at(-1)!);
        expect(() => compactionBatch(saved, [pending], {}, pending.turnId)).toThrow('безопасного сжатия');
    });
    it('Stops safely when the declared model capacity cannot fit summary instructions', () => {
        expect(() => compactionBatch(null, chatSources([turn(1, 'old', 'answer')], null), { contextWindowTokens: 128 }, 'pending')).toThrow('безопасного сжатия');
    });
});
