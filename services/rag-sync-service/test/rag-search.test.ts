import { describe, expect, it } from 'vitest';
import { projectSearchInput, searchExcerpt } from '../src/rag/rag-search';
const input = () => ({ projectId: 'prj-search', generation: 'initial-' + 'a'.repeat(32), revision: 1, dataRevision: 2,
    profile: { provider: 'openai', model: 'selected', dimension: 3 }, snapshot: 'b'.repeat(64), embedding: [1, 0, 0] });
describe('Exact project search wire contract', () => {
    it('Accepts a complete immutable context', () => { expect(projectSearchInput(input())).toEqual(input()); });
    it.each([{ projectId: '../other' }, { generation: 'other' }, { snapshot: null }, { revision: -1 }, { dataRevision: 0.1 },
        { profile: null }, { profile: { provider: 'openai', model: 'selected', dimension: 16001 } }, { embedding: [0, 0, 0] },
        { embedding: [1, 2] }, { embedding: [Infinity, 0, 0] }, { embedding: [1e100, 0, 0] }, { extra: true }])('Rejects invalid context %j', patch => {
        expect(() => projectSearchInput({ ...input(), ...patch })).toThrow();
    });
    it('UTF-8 excerpt bounds preserve complete code points', () => {
        for (const value of ['a', 'я', '界', '😀']) {
            const excerpt = searchExcerpt(value.repeat(4000)); expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(3072);
            expect(Buffer.from(excerpt).toString()).toBe(excerpt); expect(excerpt).not.toContain('�');
        }
    });
});
