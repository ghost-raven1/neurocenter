import { describe, expect, it } from 'vitest';
import { normalizeMeta, parseSkillFile, serializeSkillFile } from '../frontmatter';

describe('frontmatter', () => {
    it('round-trips metadata and preserves the instruction verbatim', () => {
        const meta = normalizeMeta({ name: 'Помощник', tags: ['код'], description: 'Описание' }, 'helper');
        const body = '# Инструкция\n\nНе менять отступы.\n';
        const parsed = parseSkillFile(serializeSkillFile(meta, body));
        expect(parsed.body).toBe(body);
        expect(normalizeMeta(parsed.meta!, 'helper')).toEqual(meta);
    });

    it('accepts a UTF-8 BOM without losing the instruction', () => {
        expect(parseSkillFile('\uFEFF---\nname: Helper\n---\nBody')).toEqual({
            meta: { name: 'Helper' },
            body: 'Body',
        });
    });

    it.each(['plain text', '---\nname: unfinished'])('keeps text without complete frontmatter: %s', (body) => {
        expect(parseSkillFile(body)).toEqual({ body });
    });

    it.each(['[broken', '- item', 'null'])('retains the body when metadata is invalid: %s', (metadata) => {
        expect(parseSkillFile(`---\n${metadata}\n---\nInstruction`)).toEqual({ meta: undefined, body: 'Instruction' });
    });

    it('derives the legacy version from history and supplies stable defaults', () => {
        expect(normalizeMeta({ history: [{ version: 3, author: 'alice' }] }, 'legacy')).toMatchObject({
            name: 'legacy',
            version: 3,
            owner: 'unknown',
            scope: 'common',
            history: [{ version: 3, author: 'alice', at: '1970-01-01T00:00:00.000Z' }],
        });
    });
});
