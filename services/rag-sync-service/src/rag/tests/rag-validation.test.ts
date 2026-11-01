import { describe, expect, it } from 'vitest';
import { validateDelta } from '../rag-validation';

const chunk = { id: 'a', filePath: 'notes.md', content: 'Содержимое', embedding: [0.5, -0.25] };

describe('validateDelta', () => {
    it('preserves chunks and deduplicates deleted IDs', () => {
        expect(validateDelta([chunk], ['b', 'b'], 2)).toEqual({ chunks: [chunk], deletes: ['b'] });
    });
    it('rejects a batch that writes and deletes the same ID', () => {
        expect(() => validateDelta([chunk], ['a'], 2)).toThrow();
    });
    it('rejects duplicate writes', () => {
        expect(() => validateDelta([chunk, chunk], [], 2)).toThrow();
    });
    it.each([[1], [NaN, 0], [Infinity, 0], [Number.MAX_VALUE, 0]])(
        'rejects incompatible embeddings %j',
        (...embedding) => {
            expect(() => validateDelta([{ ...chunk, embedding }], [], 2)).toThrow();
        },
    );
});
