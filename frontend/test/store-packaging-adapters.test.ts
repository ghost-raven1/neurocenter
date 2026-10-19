import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepositoryMetadataDetails } from '../src/modules/Store/packaging/RepositoryMetadataDetails';
import { packagingKind } from '../src/modules/Store/packaging/packagingKind';
import { repositoryBuildSource } from '../src/modules/Store/packaging/repositorySource';
import type { RepositoryAdapter, RepositoryMetadata } from '../src/modules/Store/packaging/types';

const metadata: RepositoryMetadata = {
    url: 'https://github.com/owner/tool', ref: 'main', commit: 'd'.repeat(40), name: '@scope/tool', description: 'Готовый MCP',
    entrypoint: 'neurocenter.tool.json', candidates: ['neurocenter.tool.json'], adapter: 'python', recommendedKind: 'mcp',
    supportedTargets: ['darwin-arm64', 'linux-x64-glibc'],
};
const render = (value: RepositoryMetadata) => renderToStaticMarkup(createElement(RepositoryMetadataDetails, { metadata: value, entrypoint: 'src/stale.ts' }));

describe('Готовые поставки MCP из репозитория', () => {
    it.each<RepositoryAdapter>(['python', 'java', 'dotnet', 'go', 'rust', 'native'])('Поставка %s всегда отправляется как MCP, включая прежний явный выбор плагина', adapter => {
        expect(packagingKind('plugin', { ...metadata, adapter }, true)).toBe('mcp');
    });
    it.each<[RepositoryAdapter, string]>([
        ['python', 'Python · автономный комплект'], ['java', 'Java · встроенный runtime'], ['dotnet', '.NET · встроенный runtime'],
        ['go', 'Go · готовый бинарник'], ['rust', 'Rust · готовый бинарник'], ['native', 'Native · готовый бинарник'],
    ])('Показывает способ поставки %s без обещания компиляции', (adapter, label) => {
        expect(render({ ...metadata, adapter })).toContain(label);
    });
    it('Показывает рецепт вместо файла запуска и только существующие платформы', () => {
        const html = render(metadata);
        expect(html).toContain('Рецепт поставки: neurocenter.tool.json');
        expect(html).not.toContain('Файл запуска');
        expect(html).not.toContain('src/stale.ts');
        expect(html).toContain('macOS · Apple Silicon');
        expect(html).toContain('Linux · x64 · glibc');
        expect(html).not.toContain('Windows');
        expect(html).not.toContain('macOS · Intel');
    });
    it('Не подменяет отсутствие списка платформ обещанием всех восьми целей', () => {
        const html = render({ ...metadata, supportedTargets: undefined });
        expect(html).not.toContain('Поддерживаемые платформы');
        expect(html).not.toContain('macOS');
    });
    it('Сохраняет JS entrypoint и явный тип плагина для обычного репозитория', () => {
        const javascript: RepositoryMetadata = { ...metadata, adapter: undefined, entrypoint: 'src/index.ts', recommendedKind: 'plugin' };
        expect(render(javascript)).toContain('Файл запуска: src/stale.ts');
        expect(render(javascript)).not.toContain('Рецепт поставки');
        expect(packagingKind('plugin', javascript, true)).toBe('plugin');
    });
    it('POST содержит только закреплённый рецепт без runtime JSON и старого выбора JS', () => {
        const source = repositoryBuildSource({ ...metadata, subdirectory: 'tools/mcp', runtimeSource: { secret: 'не отправлять' }, manifestSha256: 'f'.repeat(64) } as RepositoryMetadata, 'src/stale.ts');
        expect(source).toEqual({ type: 'repository', url: metadata.url, ref: metadata.commit, subdirectory: 'tools/mcp', entrypoint: 'neurocenter.tool.json' });
        expect(JSON.stringify(source)).not.toContain('runtimeSource');
        expect(JSON.stringify(source)).not.toContain('manifestSha256');
    });
});
