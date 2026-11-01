import { describe, expect, it } from 'vitest';
import { buildView, type IBuildRow } from '../package-build.model';

describe('bundled build recovery receipt', () => {
    it('restores selected input without secrets or previous publication consent', () => {
        const config = {
            source: { type: 'bundled', id: 'mcp-example', revision: 'a'.repeat(64) },
            targets: ['linux-x64'],
            kind: 'mcp',
            name: 'Example',
            description: 'Saved',
            tags: ['tag'],
            agent: { apiKey: 'secret' },
            publication: { catalogId: 'original-target', expectedSourceHash: 'old-consent' },
            files: ['private'],
        };
        const result = buildView({ id: 'build', config } as unknown as IBuildRow);
        expect(result.recovery).toEqual({
            source: config.source,
            targets: ['linux-x64'],
            kind: 'mcp',
            name: 'Example',
            description: 'Saved',
            tags: ['tag'],
            publication: { mode: 'replace', catalogId: 'original-target' },
        });
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(JSON.stringify(result)).not.toContain('old-consent');
        expect(result.recovery?.targets).not.toBe(config.targets);
    });
    it.each([
        undefined,
        { type: 'files', files: ['secret'] },
        { type: 'bundled', id: '../secret', revision: 'invalid' },
    ])('omits unsupported or legacy recovery %j', (source) => {
        expect(buildView({ config: { source } } as unknown as IBuildRow)).not.toHaveProperty('recovery');
    });
});
