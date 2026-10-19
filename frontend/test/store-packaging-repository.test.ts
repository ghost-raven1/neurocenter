import { describe, expect, it } from 'vitest';
import { repositoryBuildSource, repositoryName, repositoryQuery } from '../src/modules/Store/packaging/repositorySource';
import { packagingTitle } from '../src/modules/Store/packaging/packagingTitle';
import { packagingKind } from '../src/modules/Store/packaging/packagingKind';
import type { RepositoryMetadata } from '../src/modules/Store/packaging/types';

const metadata: RepositoryMetadata = {
    url: 'https://github.com/owner/tool', ref: 'main', commit: 'a'.repeat(40),
    name: '@scope/tool', description: 'Инструмент', entrypoint: 'src/index.ts',
    candidates: ['src/index.ts'], recommendedKind: 'plugin',
};

describe('Источник упаковки из репозитория GitHub', () => {
    it('Без дополнительных полей использует основную ветку и корень', () => {
        expect(repositoryQuery({ url: ' https://github.com/owner/tool#readme ', ref: ' ', subdirectory: '' })).toEqual({ url: 'https://github.com/owner/tool' });
        expect(repositoryName('https://github.com/owner/tool.git/tree/main')).toBe('tool');
    });
    it('Сохраняет ссылку tree, явную ветку, подпапку и выбранный файл запуска', () => {
        expect(repositoryQuery({ url: 'https://github.com/owner/tool/tree/main', ref: ' feature/tools ', subdirectory: ' packages/mcp ', entrypoint: ' src/cli.ts ' })).toEqual({
            url: 'https://github.com/owner/tool/tree/main', ref: 'feature/tools', subdirectory: 'packages/mcp', entrypoint: 'src/cli.ts',
        });
    });
    it.each(['git@github.com:owner/tool.git', 'http://github.com/owner/tool', 'https://gitlab.com/owner/tool', 'https://user:token@github.com/owner/tool', 'https://github.com:4430/owner/tool', 'https://github.com/owner/tool?access_token=secret'])('Не отправляет неподдерживаемый адрес или секрет: %s', url => {
        expect(() => repositoryQuery({ url })).toThrow();
    });
    it('Отправляет полный проверенный commit, даже если исходная ветка изменится', () => {
        const source = repositoryBuildSource(metadata, '');
        metadata.ref = 'changed-branch';
        expect(source).toEqual({ type: 'repository', url: metadata.url, ref: 'a'.repeat(40), entrypoint: 'src/index.ts' });
        expect(source.ref).not.toBe(metadata.ref);
    });
    it('Сохраняет выбор при неоднозначном entrypoint и подпапку в monorepo', () => {
        expect(repositoryBuildSource({ ...metadata, subdirectory: 'packages/mcp', candidates: ['src/index.ts', 'src/cli.ts'] }, 'src/cli.ts')).toMatchObject({
            subdirectory: 'packages/mcp', entrypoint: 'src/cli.ts', ref: 'a'.repeat(40),
        });
    });
    it('Не готовит запрос без зафиксированного commit или файла запуска', () => {
        expect(() => repositoryBuildSource({ ...metadata, commit: 'main' }, '')).toThrow('commit');
        expect(() => repositoryBuildSource({ ...metadata, commit: 'a'.repeat(12) }, '')).toThrow('commit');
        expect(() => repositoryBuildSource({ ...metadata, entrypoint: '' }, '')).toThrow('файл запуска');
    });
    it('Принимает полный SHA-256 commit и сохраняет все 64 символа', () => {
        expect(repositoryBuildSource({ ...metadata, commit: 'b'.repeat(64) }, '').ref).toBe('b'.repeat(64));
    });
    it('Scoped имя из package.json становится допустимым названием каталога', () => {
        expect(packagingTitle('', metadata.name)).toBe('scope · tool');
    });
    it('Рекомендованный тип применяется до первого запроса и уважает явный выбор', () => {
        expect(packagingKind('mcp', metadata, false)).toBe('plugin');
        expect(packagingKind('mcp', metadata, true)).toBe('mcp');
    });
});
