import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestHash, validateBuildInput } from '../src/package-build/package-build.model';
import { resolveNpmSource } from '../src/package-build/npm-source';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';

const input = {requestKey: '7428c85e-c645-4f05-b610-6f0029867f93', kind: 'plugin', name: 'Проверка кода', description: 'Локальный плагин', // gitleaks:allow — тестовый UUID идемпотентного запроса, не ключ доступа.
    source: {type: 'files', entrypoint: 'src/index.ts', files: [{path: 'src/index.ts', content: 'export default async () => ({})'}]}};

describe('Границы серверной сборки', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('Принимает исходники TypeScript и задаёт все поддерживаемые платформы', () => {
        const value = validateBuildInput(input);
        expect(value.targets).toHaveLength(8);
        expect(value.source).toMatchObject({type: 'files', entrypoint: 'src/index.ts'});
    });
    it.each(['mts', 'cts'])('Принимает .%s одинаково из файлов, npm и репозитория до постановки в очередь', async extension => {
        const entrypoint = `server.${extension}`;
        const files = [{path: entrypoint, content: 'export const fixture: string = "fixture";'}];
        expect(validateBuildInput({...input, source: {type: 'files', files, entrypoint}}).source).toMatchObject({entrypoint});
        expect(validateBuildInput({...input, source: {type: 'npm', specifier: 'fixture@1.0.0', entrypoint}}).source).toMatchObject({entrypoint});
        expect(validateBuildInput({...input, source: {type: 'repository', url: 'https://github.com/owner/tool', entrypoint}}).source).toMatchObject({entrypoint});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({name: 'fixture', version: '1.0.0', main: entrypoint})));
        expect(await resolveNpmSource('fixture@1.0.0')).toMatchObject({entrypoint});
    });
    it.each(['server.d.ts', 'server.d.mts', 'server.d.cts'])('Не принимает декларацию %s ни в одном источнике сборки', async entrypoint => {
        const files = [{path: entrypoint, content: 'export declare const fixture: string;'}];
        for (const source of [{type: 'files', files, entrypoint}, {type: 'npm', specifier: 'fixture@1.0.0', entrypoint},
            {type: 'repository', url: 'https://github.com/owner/tool', entrypoint}]) {
            expect(() => validateBuildInput({...input, source})).toThrow('без деклараций');
        }
        vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({name: 'fixture', version: '1.0.0', bin: entrypoint, main: 'server.mts'})));
        expect(await resolveNpmSource('fixture@1.0.0')).toMatchObject({entrypoint: 'server.mts', candidates: ['server.mts']});
        await expect(resolveNpmSource('fixture@1.0.0', entrypoint)).rejects.toThrow('без деклараций');
    });
    it('Нормализует tree-ссылку до очереди и сохраняет ref в отпечатке исходного запроса', () => {
        const value = validateBuildInput({...input, source: {type: 'repository', url: 'https://github.com/owner/repo/tree/main/packages/tool', entrypoint: 'src/index.ts'}});
        expect(value.source).toEqual({type: 'repository', url: 'https://github.com/owner/repo', ref: 'main', subdirectory: 'packages/tool', entrypoint: 'src/index.ts'});
        expect(requestHash(value)).not.toBe(requestHash({...value, source: {...value.source, ref: 'release'}}));
        expect(() => validateBuildInput({...input, source: {type: 'repository', url: 'https://github.com/owner/repo', command: 'git clone'}})).toThrow();
    });
    it('Разрешает имя runtime manifest, но не принимает от клиента его runtimeSource и SHA', () => {
        const source = {type: 'repository', url: 'https://github.com/owner/repo', entrypoint: 'neurocenter.tool.json'};
        expect(validateBuildInput({...input, source}).source).toEqual(source);
        expect(() => validateBuildInput({...input, source: {...source, runtimeSource: {type: 'runtime'}, manifestSha256: 'a'.repeat(64)}})).toThrow('неподдерживаемые поля');
    });
    it.each([
        {...input, command: 'curl install | bash'},
        {...input, targets: ['darwin-arm64', 'darwin-arm64']},
        {...input, source: {...input.source, files: [{path: '../index.ts', content: 'x'}]}},
        {...input, source: {...input.source, files: [{path: '.env', content: 'TOKEN=private'}]}},
        {...input, source: {...input.source, files: [{path: 'index.ts', content: 'x'}]}},
        {...input, source: {...input.source, args: ['x\ncommand']}},
    ])('Отказывает опасному или неполному входу до запуска сборщика: %j', value => {
        expect(() => validateBuildInput(value)).toThrow();
    });
    it('Не даёт ссылке npm превратиться в SSRF или shell-команду', async () => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        for (const specifier of ['https://internal.test/x', 'package;rm', 'git+https://example.test/pkg', 'package@^1.0.0', '@scope/package@main']) {
            await expect(resolveNpmSource(specifier)).rejects.toThrow();
        }
        expect(fetch).not.toHaveBeenCalled();
    });
    it('Разрешает latest в точную версию и предлагает переносимый bin перед main', async () => {
        const fetch = vi.fn().mockResolvedValue(Response.json({name: '@scope/package', version: '1.2.3',
            description: 'Описание', bin: {tool: './dist/cli.js', bad: '../../private.js'}, main: 'dist/index.js'}));
        vi.stubGlobal('fetch', fetch);
        expect(await resolveNpmSource('@scope/package')).toMatchObject({package: '@scope/package', version: '1.2.3',
            specifier: '@scope/package@1.2.3', entrypoint: 'dist/cli.js', candidates: ['dist/cli.js', 'dist/index.js']});
        expect(fetch.mock.calls[0][0]).toBe('https://registry.npmjs.org/%40scope%2Fpackage/latest');
        expect(fetch.mock.calls[0][1].redirect).toBe('error');
    });
    it('Обрыв npm-описания после заголовков даёт понятный отказ и позволяет исправный повтор', async () => {
        let chunks = 0;
        const response = new Response(new ReadableStream<Uint8Array>({pull(controller) {
            if (chunks++ === 0) controller.enqueue(new TextEncoder().encode('{"name":"fixture",'));
            else controller.error(new TypeError('upstream socket reset'));
        }}));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response)
            .mockResolvedValueOnce(Response.json({name: 'fixture', version: '1.0.0', main: 'index.js'})));
        await expect(resolveNpmSource('fixture@1.0.0')).rejects.toMatchObject({status: 400, message: 'npm-реестр недоступен. Повторите проверку пакета.'});
        expect(response.body?.locked).toBe(false);
        await expect(resolveNpmSource('fixture@1.0.0')).resolves.toMatchObject({version: '1.0.0', entrypoint: 'index.js'});
    });
    it('Ошибка отмены слишком большого npm-описания не скрывает причину отказа', async () => {
        const cancel = vi.fn(async () => {throw new TypeError('upstream cancel failed');});
        const response = new Response(new ReadableStream<Uint8Array>({start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
        }, cancel}));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
        await expect(resolveNpmSource('fixture@1.0.0')).rejects.toMatchObject({status: 400, message: 'Описание npm-пакета превышает допустимый размер.'});
        expect(cancel).toHaveBeenCalledOnce();
        expect(response.body?.locked).toBe(false);
    });
    it('Не принимает подменённую npm-версию и пакет без файла запуска', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({name: 'package', version: '2.0.0', main: 'index.js'}))
            .mockResolvedValueOnce(Response.json({name: 'package', version: '1.0.0'})));
        await expect(resolveNpmSource('package@1.0.0')).rejects.toThrow('другую версию');
        await expect(resolveNpmSource('package@1.0.0')).rejects.toThrow('не найден');
    });
    it('Ссылка npm нормализуется локально, а TypeScript entrypoint сохраняется для общего компилятора', async () => {
        const fetch = vi.fn().mockResolvedValue(Response.json({name: '@scope/package', version: '1.2.3', main: './src/index.ts'}));
        vi.stubGlobal('fetch', fetch);
        expect(await resolveNpmSource('https://www.npmjs.com/package/@scope/package/v/1.2.3')).toMatchObject({specifier: '@scope/package@1.2.3', entrypoint: 'src/index.ts'});
        expect(fetch.mock.calls[0][0]).toBe('https://registry.npmjs.org/%40scope%2Fpackage/1.2.3');
        await expect(resolveNpmSource('https://www.npmjs.com/package/package?token=private')).rejects.toThrow();
        await expect(resolveNpmSource('https://www.npmjs.com.evil.test/package/package')).rejects.toThrow();
    });
    it('Известный RAG получает MCP-адаптер и исключает неподдерживаемый Intel Mac', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({name: 'opencode-rag-plugin', version: '2.4.4'}))
            .mockResolvedValueOnce(Response.json({name: 'opencode-rag-plugin', version: '2.5.0'})));
        const resolved = await resolveNpmSource('opencode-rag-plugin');
        expect(resolved.recommendedKind).toBe('mcp');
        expect(resolved.supportedTargets).toHaveLength(7);
        expect(resolved.supportedTargets).not.toContain('darwin-x64');
        await expect(resolveNpmSource('opencode-rag-plugin@2.5.0')).rejects.toThrow('подготовлен совместимый адаптер');
    });
    it('Проверка npm находит root conditional exports без устаревшего поля main',async()=>{
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({name:'modern-plugin',version:'1.0.0',
            exports:{'.':{types:'./dist/index.d.ts',node:{import:'./dist/index.mjs',require:'./dist/index.cjs'}},'./private':'./dist/private.js'}})));
        expect(await resolveNpmSource('modern-plugin@1.0.0')).toMatchObject({entrypoint:'dist/index.mjs',candidates:['dist/index.mjs','dist/index.cjs']});
    });
    it('Проверка npm использует module и не предлагает недопустимые export пути',async()=>{
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({name:'modern-plugin',version:'1.0.0',module:'./dist/plugin.js',
            exports:{'.':{import:'../../private.mjs',default:'./dist/plugin.js',require:'./dist/plugin.cjs'}}})));
        expect(await resolveNpmSource('modern-plugin')).toMatchObject({entrypoint:'dist/plugin.js',candidates:['dist/plugin.js','dist/plugin.cjs']});
    });
    it('Npm preview и submit принимают TSX, который поддерживает общий compiler',async()=>{
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({name:'modern-plugin',version:'1.0.0',exports:{'.':'./src/index.tsx'}})));
        const resolved=await resolveNpmSource('modern-plugin');
        expect(resolved.entrypoint).toBe('src/index.tsx');
        expect(validateBuildInput({...input,source:{type:'npm',specifier:resolved.specifier,entrypoint:resolved.entrypoint}}).source).toMatchObject({entrypoint:'src/index.tsx'});
        expect(validateBuildInput({...input,source:{type:'files',entrypoint:'index.tsx',files:[{path:'index.tsx',content:'export default async () => ({})'}]}}).source).toMatchObject({entrypoint:'index.tsx'});
    });
});

const mocks = vi.hoisted(() => ({pool: {query: vi.fn(), connect: vi.fn(), end: vi.fn()}, lease: {query: vi.fn(), release: vi.fn(), on: vi.fn()}, reserve: vi.fn()}));
vi.mock('../src/database/pool', () => ({createPool: () => mocks.pool}));
vi.mock('../../shared/capacity.cjs', () => ({reserveCapacity: mocks.reserve}));
vi.mock('../src/devices/device-operations', () => ({notifyDeviceOperations: vi.fn()}));
import { PackageBuildService } from '../src/package-build/package-build.service';
import type { AccessDb } from '../src/access/access-db';
import type { RuntimeArtifacts } from '../src/runtime-artifacts/runtime-artifacts';
import type { CatalogService } from '../src/catalog/catalog.service';
import type { BuildConfiguration } from '../src/package-build/package-build.model';

describe('Владение очередью серверной сборки', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.pool.query.mockResolvedValue({rows: []});
        mocks.pool.connect.mockResolvedValue(mocks.lease);
        mocks.lease.query.mockResolvedValue({rows: []});
        mocks.reserve.mockResolvedValue(vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());
    const service = (roles: string[]) => {
        const builds = new PackageBuildService({claims: vi.fn().mockResolvedValue({userRoles: roles})} as unknown as AccessDb, {} as RuntimeArtifacts,
            {ensureSchema: vi.fn()} as unknown as CatalogService);
        Object.assign(builds, {stagingRoot: async () => '/unused-test-stage'});
        return builds;
    };
    it('Реплика без advisory lock не помечает живые задания прерванными', async () => {
        mocks.lease.query.mockResolvedValueOnce({rows: [{locked: false}]});
        const builds = service(['Главный админ']);
        await builds.onModuleInit();
        expect(mocks.pool.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE tool_build_jobs'))).toBe(false);
        expect(mocks.lease.release).toHaveBeenCalledOnce();
        await builds.onModuleDestroy();
    });
    it('После получения lock закрывает прерванные задания одной транзакцией', async () => {
        mocks.lease.query.mockResolvedValueOnce({rows: [{locked: true}]}).mockResolvedValue({rows: []});
        const builds = service(['Главный админ']);
        await builds.onModuleInit();
        await new Promise(resolve => setImmediate(resolve));
        expect(mocks.lease.query.mock.calls.map(([sql]) => String(sql))).toEqual([
            'SELECT pg_try_advisory_lock(72465395) AS locked', 'BEGIN', expect.stringContaining("SET state='FAILED'"), 'COMMIT',
            'BEGIN', expect.stringContaining("state='QUEUED'"), 'COMMIT',
        ]);
        await builds.onModuleDestroy();
        expect(mocks.lease.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock(72465395)');
    });
    it('Отзыв роли запрещает просмотр npm и создание задания без сетевого запроса', async () => {
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        const builds = service([]), actor = {email: 'admin@example.test', activeRole: 'Главный админ'};
        await expect(builds.create(actor, input)).rejects.toThrow('главный администратор');
        await expect(builds.npm(actor, 'package')).rejects.toThrow('главный администратор');
        await expect(builds.repositorySource(actor, {url: 'https://github.com/owner/repo'})).rejects.toThrow('главный администратор');
        await expect(builds.archiveSource(actor, {name: 'invalid.zip', contentBase64: 'invalid'})).rejects.toThrow('главный администратор');
        expect(fetch).not.toHaveBeenCalled();
        expect(mocks.pool.query).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
    it('Preview архива проверяет актуальную роль и работает без владельца очереди или записи в PG', async () => {
        const builds = service(['Главный админ']);
        const archive = artifactFixture([{path: 'tool/index.ts', content: 'export default 1;'}]).archive;
        await expect(builds.archiveSource({email: 'admin@example.test', activeRole: 'Главный админ'},
            {name: 'tool.tgz', contentBase64: archive.toString('base64')})).resolves.toEqual({rootName: 'tool', skipped: 0, files: [{path: 'index.ts', content: 'export default 1;'}]});
        expect(mocks.pool.query).not.toHaveBeenCalled();
        expect(mocks.pool.connect).not.toHaveBeenCalled();
        expect(mocks.reserve).not.toHaveBeenCalled();
    });
    it('Повтор repository-запроса возвращает сохранённый commit без повторного чтения изменившейся ветки', async () => {
        const actor = {email: 'admin@example.test', activeRole: 'Главный админ'};
        const request = {...input, source: {type: 'repository', url: 'https://github.com/owner/repo', ref: 'main', entrypoint: 'src/index.ts'}};
        const fingerprint = requestHash(validateBuildInput(request));
        mocks.pool.query.mockResolvedValue({rows: [{id: input.requestKey, request_hash: fingerprint, state: 'RUNNING', percent: 30,
            config: {source: {type: 'repository', commit: 'a'.repeat(40)}}}]});
        const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        expect(await service(['Главный админ']).create(actor, request)).toMatchObject({id: input.requestKey, state: 'RUNNING', percent: 30});
        expect(fetch).not.toHaveBeenCalled();
        expect(mocks.pool.query).toHaveBeenCalledWith('SELECT * FROM tool_build_jobs WHERE actor=$1 AND request_key=$2', [actor.email, input.requestKey]);
        vi.unstubAllGlobals();
    });
    const runtime = {type: 'runtime', adapter: 'native', assets: {'darwin-arm64': {app: {directory: '.', entrypoint: 'bin/mcp', executables: ['bin/mcp']}}}};
    const manifestFetch = () => vi.fn(async (value: string) => {
        const url = new URL(value), sha = 'c'.repeat(40), raw = JSON.stringify({schemaVersion: 1, source: runtime});
        if (url.pathname === '/repos/owner/repo') {return Response.json({name: 'repo', private: false, default_branch: 'main'});}
        if (url.pathname.includes('/commits/')) {return Response.json({sha});}
        expect(url.searchParams.get('ref')).toBe(sha);
        if (url.pathname.endsWith('/neurocenter.tool.json')) {return Response.json({type: 'file', encoding: 'base64', size: Buffer.byteLength(raw), content: Buffer.from(raw).toString('base64')});}
        return Response.json([{name: 'neurocenter.tool.json', type: 'file'}]);
    });
    it('До enqueue отклоняет runtime как плагин и платформы без готового комплекта', async () => {
        const actor = {email: 'admin@example.test', activeRole: 'Главный админ'}, builds = service(['Главный админ']);
        const enqueue = vi.fn();
        Object.assign(builds, {lease: mocks.lease, repository: {existing: vi.fn(), enqueue}});
        vi.stubGlobal('fetch', manifestFetch());
        const request = {...input, source: {type: 'repository', url: 'https://github.com/owner/repo', entrypoint: 'neurocenter.tool.json'}};
        await expect(builds.create(actor, request)).rejects.toThrow('автономный MCP');
        await expect(builds.create(actor, {...request, kind: 'mcp', targets: ['darwin-x64']})).rejects.toThrow('нет комплекта');
        expect(enqueue).not.toHaveBeenCalled();
        expect(mocks.reserve).not.toHaveBeenCalled();
    });
    it('Автоматически выбирает только targets manifest и сохраняет закреплённый runtime до постановки в очередь', async () => {
        const actor = {email: 'admin@example.test', activeRole: 'Главный админ'}, builds = service(['Главный админ']);
        const enqueue = vi.fn(async (_actor: string, _key: string, _hash: string, config: BuildConfiguration) =>
            ({id: input.requestKey, config, state: 'SUCCEEDED', result: null}));
        Object.assign(builds, {lease: mocks.lease, repository: {existing: vi.fn(), enqueue}, stagingRoot: vi.fn().mockResolvedValue('/unused-test-stage')});
        vi.stubGlobal('fetch', manifestFetch());
        const request = {...input, kind: 'mcp', source: {type: 'repository', url: 'https://github.com/owner/repo', entrypoint: 'neurocenter.tool.json'}};
        await builds.create(actor, request);
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.calls[0][3]).toMatchObject({targets: ['darwin-arm64'], source: {type: 'repository', commit: 'c'.repeat(40),
            entrypoint: 'neurocenter.tool.json', runtimeSource: runtime, manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/)}});
        expect(enqueue.mock.calls[0][2]).toBe(requestHash(validateBuildInput(request)));
    });
    it('Обрыв lease во время unlock не приводит к двойному release и не оставляет пул открытым', async () => {
        mocks.lease.query.mockResolvedValueOnce({rows: [{locked: true}]}).mockResolvedValue({rows: []});
        const builds = service(['Главный админ']);
        await builds.onModuleInit();
        const onError = mocks.lease.on.mock.calls.find(([name]) => name === 'error')![1];
        mocks.lease.release.mockClear();
        mocks.lease.query.mockImplementation(async (sql: string) => {
            if (sql.includes('pg_advisory_unlock')) {onError(new Error('Соединение оборвано')); throw new Error('unlock failed');}
            return {rows: []};
        });
        Object.assign(builds, {worker: Promise.reject(new Error('Ошибка очистки рабочего каталога'))});
        await expect(builds.onModuleDestroy()).resolves.toBeUndefined();
        expect(mocks.lease.release).toHaveBeenCalledOnce();
        expect(mocks.pool.end).toHaveBeenCalledOnce();
    });
});
