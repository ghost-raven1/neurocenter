vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RAG_PLUGIN_SOURCE, isPreparedRagRepository} from '../../shared/opencode-rag-source.cjs';
import {resolveRepositorySource} from '../../shared/repository-source.cjs';
import type {AccessDb} from '../src/access/access-db';
import type {RuntimeArtifacts} from '../src/runtime-artifacts/runtime-artifacts';
import type {CatalogService} from '../src/catalog/catalog.service';
import type {BuildConfiguration} from '../src/package-build/package-build.model';

vi.mock('../src/database/pool', () => ({createPool: () => ({})}));
vi.mock('../../shared/capacity.cjs', () => ({reserveCapacity: async () => () => undefined}));
vi.mock('../src/devices/device-operations', () => ({notifyDeviceOperations: vi.fn()}));
import {PackageBuildService} from '../src/package-build/package-build.service';

const source = RAG_PLUGIN_SOURCE;
const actor = {email: 'admin@example.test', activeRole: 'Главный админ'};
const request = {requestKey: 'dfdabcc1-de40-47de-a526-4c02fc168a43', name: 'OpenCodeRAG (плагин)', kind: 'plugin', description: 'Плагин MrDoe',
    source: {type: 'repository', url: 'https://github.com/MrDoe/OpenCodeRAG/tree/main'}};

function github(entryType = 'file') {
    return vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://api.github.com');
        if (url.pathname.endsWith('/commits/main') || url.pathname.endsWith('/commits/' + source.commit)) {return Response.json({sha: source.commit});}
        if (!url.pathname.includes('/contents/')) {return Response.json({name: 'OpenCodeRAG', private: false, default_branch: 'main'});}
        expect(url.pathname).toBe('/repos/mrdoe/opencoderag/contents/src/plugin.ts');
        expect(url.searchParams.get('ref')).toBe(source.commit);
        return Response.json({type: entryType, size: 1024});
    });
}

describe('Плагин MrDoe из закреплённого GitHub', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('Предлагает совместимый плагин и семь платформ вместо неподдерживаемого V2 entrypoint', async () => {
        const fetch = github();
        const preview = await resolveRepositorySource({url: request.source.url}, {fetch: fetch as typeof globalThis.fetch});
        expect(preview).toMatchObject({url: source.url, commit: source.commit, entrypoint: source.entrypoint, candidates: [source.entrypoint],
            name: request.name, recommendedKind: 'plugin', preparedAdapter: source.adapter, preparedVersion: source.version});
        expect(preview.supportedTargets).toEqual(source.supportedTargets);
        expect(preview.supportedTargets).not.toContain('darwin-x64');
        expect(fetch).toHaveBeenCalledTimes(3);
    });
    it('Повтор перед enqueue сверяет тот же commit и файл, даже без загрузки общих метаданных', async () => {
        const preview = await resolveRepositorySource({url: source.url, ref: source.commit, entrypoint: source.entrypoint}, {fetch: github() as typeof globalThis.fetch, metadata: false});
        expect(preview.preparedAdapter).toBe(source.adapter);
        expect(preview.commit).toBe(source.commit);
    });
    it('Ссылка вместо файла останавливает подготовку совместимой поставки', async () => {
        await expect(resolveRepositorySource({url: source.url}, {fetch: github('symlink') as typeof globalThis.fetch})).rejects.toThrow('отсутствует');
    });
    it.each([
        {url: 'https://github.com/other/opencoderag'}, {commit: 'a'.repeat(40)},
        {subdirectory: 'packages/plugin'}, {entrypoint: 'src/plugin-entry.ts'},
    ])('Чужие или изменённые исходники не подменяются известным пакетом: %j', change => {
        expect(isPreparedRagRepository({...source, ...change})).toBe(false);
    });
    const service = () => {
        const builds = new PackageBuildService({claims: async () => ({userRoles: ['Главный админ']})} as unknown as AccessDb, {} as RuntimeArtifacts, {} as CatalogService);
        const enqueue = vi.fn(async (_actor: string, _key: string, _hash: string, config: BuildConfiguration) => ({id: request.requestKey, config, state: 'SUCCEEDED'}));
        Object.assign(builds, {lease: {}, repository: {existing: vi.fn(), enqueue}, stagingRoot: async () => '/unused-test-stage'});
        vi.stubGlobal('fetch', github());
        return {builds, enqueue};
    };
    it('Сохраняет исходный commit и поддерживаемые платформы до постановки в очередь', async () => {
        const {builds, enqueue} = service();
        await builds.create(actor, request);
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.calls[0][3]).toMatchObject({kind: 'plugin', targets: [...source.supportedTargets],
            source: {type: 'repository', url: source.url, commit: source.commit, entrypoint: source.entrypoint}});
    });
    it('Отклоняет неверный тип или неподдерживаемую платформу до enqueue', async () => {
        const {builds, enqueue} = service();
        await expect(builds.create(actor, {...request, kind: 'mcp'})).rejects.toThrow('как плагин');
        await expect(builds.create(actor, {...request, targets: ['darwin-x64']})).rejects.toThrow('Intel Mac');
        expect(enqueue).not.toHaveBeenCalled();
    });
});
