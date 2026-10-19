import { describe, expect, it } from 'vitest';
import { validatePublication } from '../src/publication/publication-validation';
import { buildPackage, verifyPackage } from '../src/catalog/bundle-package';
import { assertInstallablePackage } from '../src/devices/installation-set';

const localUi = { schemaVersion: 1, application: 'opencode-rag', entrypoint: 'opencode-rag.mjs', args: ['ui', '--port', '0', '--no-open'] };
const artifact = { target: 'darwin-arm64', sha256: 'a'.repeat(64), compressedBytes: 100, unpackedBytes: 200, filesCount: 2 };
const source = (kind: 'mcp' | 'plugin' = 'mcp') => ({ name: 'OpenCodeRAG', kind, description: 'Приватное подключение модели через мост', files: [],
    config: { ...(kind === 'mcp' ? { transport: 'stdio', args: ['mcp'] } : { entrypoint: 'rag-plugin.mjs' }), extra: {
        runtimeArtifacts: [{ ...artifact, entrypoint: kind === 'mcp' ? 'opencode-rag.mjs' : 'rag-plugin.mjs' }],
        localUi, hostedEmbedding: { schemaVersion: 1 },
    } } });

describe('Публикация приватного подключения модели OpenCodeRAG', () => {
    it.each(['mcp', 'plugin'] as const)('Сохраняет точный hosted marker в закреплённом %s и в SHA пакета', kind => {
        const input = source(kind), result = validatePublication(input);
        expect(result.config?.extra?.hostedEmbedding).toEqual({ schemaVersion: 1 });
        expect(result.config?.extra?.hostedEmbedding).not.toBe(input.config.extra.hostedEmbedding);
        expect(result.config?.extra?.localUi).toEqual(localUi);
        expect(result.config?.extra?.runtimeArtifacts).toEqual(input.config.extra.runtimeArtifacts);
        const pkg = buildPackage({ id: 'ai-plug-rag-hosted', kind, name: result.name, version: 1 }, [], '', result.config);
        expect(verifyPackage(pkg)).toBe(true);
        expect(() => assertInstallablePackage(pkg)).not.toThrow();
        expect(pkg.config?.extra?.hostedEmbedding).toEqual({ schemaVersion: 1 });
    });
    it.each([null, false, 1, '1', [], {}, { schemaVersion: 2 }, { schemaVersion: '1' },
        { schemaVersion: 1, apiKey: 'synthetic-secret' }, { schemaVersion: 1, command: 'sh' },
        { schemaVersion: 1, baseUrl: 'https://example.test' }])('Отклоняет неподдерживаемый hosted marker: %j', hostedEmbedding => {
        const input = source();
        expect(() => validatePublication({ ...input, config: { ...input.config, extra: { ...input.config.extra, hostedEmbedding } } })).toThrow();
    });
    it.each(['mcp', 'plugin'] as const)('Не разрешает marker без управляемого localUi для %s', kind => {
        const input = source(kind), { localUi: _ui, ...extra } = input.config.extra;
        expect(() => validatePublication({ ...input, config: { ...input.config, extra } })).toThrow('hostedEmbedding');
    });
    it('Не заменяет проверку закреплённого runtime и не включает поддержку в старом пакете', () => {
        const input = source(), { runtimeArtifacts: _artifacts, ...extra } = input.config.extra;
        expect(() => validatePublication({ ...input, config: { ...input.config, extra } })).toThrow();
        const { hostedEmbedding: _hosted, ...ordinary } = input.config.extra;
        expect(validatePublication({ ...input, config: { ...input.config, extra: ordinary } }).config?.extra).not.toHaveProperty('hostedEmbedding');
    });
});
