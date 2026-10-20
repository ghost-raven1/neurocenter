import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {createHash} from 'node:crypto';

const {parseRepositoryUrl, validateRepositorySource, validateRepositoryManifest, resolveRepositorySource} = createRequire(import.meta.url)('../../services/shared/repository-source.cjs');
const commit = 'a'.repeat(40);
const packageJson = {name: 'example-mcp', description: 'Поиск проекта', main: 'dist/index.js',
    dependencies: {'@modelcontextprotocol/sdk': '1.0.0'}};
const runtimeSource = {type: 'runtime', adapter: 'python', assets: {'darwin-arm64': {
    app: {directory: '.', entrypoint: 'main.py'},
    runtime: {url: 'https://downloads.example.com/python.tar.gz', sha256: 'b'.repeat(64), format: 'tar.gz', entrypoint: 'bin/python3'},
}}};
const toolManifest = {schemaVersion: 1, name: 'Python MCP', description: 'Готовый Python-комплект', source: runtimeSource};

function fixture(options = {}) {
    const requests = [];
    const metadata = options.package ?? packageJson;
    const raw = JSON.stringify(metadata);
    const manifestRaw = options.manifestRaw ?? (options.manifest ? JSON.stringify(options.manifest) : undefined);
    const entryName = options.entryName ?? 'index.ts';
    const fetch = async (value, init) => {
        const url = new URL(value); requests.push({url, init});
        assert.equal(url.origin, 'https://api.github.com');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, undefined);
        if (url.pathname === '/repos/owner/repo') {return Response.json({name: 'repo', private: options.private ?? false, default_branch: 'main', description: 'Репозиторий'});}
        if (url.pathname.startsWith('/repos/owner/repo/commits/')) {return Response.json({sha: options.sha ?? commit});}
        assert.equal(url.searchParams.get('ref'), commit);
        const relative = url.pathname.slice('/repos/owner/repo/contents'.length).replace(/^\//, '').replace(/^packages\/tool\/?/, '');
        if (!relative) {return Response.json([{name: 'package.json', type: 'file', size: Buffer.byteLength(raw)}, {name: 'src', type: 'dir', size: 0},
            ...(manifestRaw !== undefined || options.manifestFile ? [{name: 'neurocenter.tool.json', type: 'file', size: 100}] : [])]);}
        if (relative === 'neurocenter.tool.json' && (manifestRaw !== undefined || options.manifestFile)) {return Response.json(options.manifestFile ??
            {type: 'file', encoding: 'base64', content: Buffer.from(manifestRaw).toString('base64'), size: Buffer.byteLength(manifestRaw)});}
        if (relative === 'package.json') {return Response.json(options.packageFile ?? {type: 'file', encoding: 'base64', content: Buffer.from(raw).toString('base64'), size: Buffer.byteLength(raw)});}
        if (relative === 'src') {return Response.json([{name: entryName, type: 'file', size: 100}]);}
        if (relative === 'src/' + entryName) {return Response.json({type: options.entryType ?? 'file', size: 100});}
        return Response.json({message: 'Not Found'}, {status: 404});
    };
    return {fetch, requests};
}

test('Нормализует канонический GitHub URL, .git и обычную tree-ссылку с папкой', () => {
    assert.deepEqual(parseRepositoryUrl('https://github.com/Owner/Repo.git/'), {url: 'https://github.com/owner/repo', owner: 'owner', repository: 'repo'});
    assert.deepEqual(parseRepositoryUrl('https://github.com/Owner/Repo/tree/main/packages/tool'), {url: 'https://github.com/owner/repo', owner: 'owner', repository: 'repo', ref: 'main', subdirectory: 'packages/tool'});
});

test('Ветка со слешем задаётся явно или одним закодированным сегментом', () => {
    assert.equal(parseRepositoryUrl('https://github.com/owner/repo/tree/feature%2Fbranch/src').ref, 'feature/branch');
    assert.deepEqual(parseRepositoryUrl('https://github.com/owner/repo/tree/feature/branch/packages/tool', {ref: 'feature/branch'}),
        {url: 'https://github.com/owner/repo', owner: 'owner', repository: 'repo', ref: 'feature/branch', subdirectory: 'packages/tool'});
    assert.throws(() => parseRepositoryUrl('https://github.com/owner/repo/tree/main/pkg', {ref: 'other'}), /ref не совпадает/);
});

test('Не превращает ссылку или ref в SSRF, выражение Git или обход относительных путей', async () => {
    let calls = 0;
    const fetch = async () => {calls++; throw new Error('Сети быть не должно');};
    for (const source of [
        {url: 'http://github.com/owner/repo'}, {url: 'https://github.com.evil.test/owner/repo'},
        {url: 'https://token@github.com/owner/repo'}, {url: 'https://github.com/owner/repo?token=secret'},
        {url: 'https://github.com/owner/repo/tree/main/%2e%2e/private'},
        {url: 'https://github.com/owner/repo', subdirectory: '../secret'},
        {url: 'https://github.com/owner/repo', ref: 'main;curl'},
    ]) {await assert.rejects(resolveRepositorySource(source, {fetch}));}
    assert.equal(calls, 0);
});

test('Builder принимает полный SHA, а плавающая ветка остаётся только HTTP-входом', () => {
    assert.deepEqual(validateRepositorySource({type: 'repository', url: 'https://github.com/Owner/Repo', commit: commit.toUpperCase(), entrypoint: 'src/index.ts'}),
        {type: 'repository', url: 'https://github.com/owner/repo', commit, entrypoint: 'src/index.ts'});
    assert.throws(() => validateRepositorySource({type: 'repository', url: 'https://github.com/owner/repo', commit: 'main', entrypoint: 'src/index.ts'}), /полным SHA/);
    assert.throws(() => validateRepositorySource({type: 'repository', url: 'https://github.com/owner/repo', commit, entrypoint: 'src/index.ts', command: 'npm install'}), /неподдерживаемые поля/);
});

test('Метаданные ветки закрепляются commit до чтения файлов и находят существующий src вместо отсутствующего dist', async () => {
    const f = fixture();
    const result = await resolveRepositorySource({url: 'https://github.com/owner/repo/tree/main/packages/tool'}, {fetch: f.fetch});
    assert.deepEqual(result, {url: 'https://github.com/owner/repo', commit, ref: 'main', subdirectory: 'packages/tool', entrypoint: 'src/index.ts',
        candidates: ['src/index.ts'], name: 'example-mcp', description: 'Поиск проекта', recommendedKind: 'mcp', requiresEntrypointChoice: false, runnableKinds: ['mcp'], warnings: []});
    assert.equal(f.requests[1].url.pathname, '/repos/owner/repo/commits/main');
    assert.ok(f.requests.slice(2).every(request => request.url.searchParams.get('ref') === commit));
});

for (const entryName of ['index.mts', 'server.cts']) test(`Метаданные репозитория находят src/${entryName} и исключают декларацию bin`, async () => {
    const f = fixture({entryName, package: {name: 'typescript-fixture', bin: 'src/server.d.ts'}});
    const result = await resolveRepositorySource({url: 'https://github.com/owner/repo'}, {fetch: f.fetch});
    assert.equal(result.entrypoint, 'src/' + entryName);
    assert.deepEqual(result.candidates, ['src/' + entryName]);
});

test('Перед enqueue уточнённый entrypoint проверяется тремя запросами без лишнего просмотра проекта', async () => {
    const f = fixture();
    const result = await resolveRepositorySource({type: 'repository', url: 'https://github.com/owner/repo', ref: commit, entrypoint: 'src/index.ts'}, {fetch: f.fetch, metadata: false});
    assert.equal(result.commit, commit); assert.equal(result.entrypoint, 'src/index.ts');
    assert.equal(f.requests.length, 3);
});

test('Частный репозиторий, неверный SHA и ссылка вместо entrypoint не доходят до сборки', async () => {
    const privateFixture = fixture({private: true});
    await assert.rejects(resolveRepositorySource({url: 'https://github.com/owner/repo'}, {fetch: privateFixture.fetch}), /публичные/);
    assert.equal(privateFixture.requests.length, 1);
    const badCommit = fixture({sha: 'main'});
    await assert.rejects(resolveRepositorySource({url: 'https://github.com/owner/repo'}, {fetch: badCommit.fetch}), /полный SHA/);
    const symlink = fixture({entryType: 'symlink'});
    await assert.rejects(resolveRepositorySource({url: 'https://github.com/owner/repo', entrypoint: 'src/index.ts'}, {fetch: symlink.fetch, metadata: false}), /является ссылкой/);
});

test('package.json проверяется по типу, размеру и канонической base64', async () => {
    for (const packageFile of [
        {type: 'file', encoding: 'base64', size: 65537, content: ''},
        {type: 'symlink', encoding: 'base64', size: 2, content: 'e30='},
        {type: 'file', encoding: 'base64', size: 2, content: 'e30=??'},
    ]) {const f = fixture({packageFile}); await assert.rejects(resolveRepositorySource({url: 'https://github.com/owner/repo'}, {fetch: f.fetch}), /package.json/);}
});

test('Ограничение GitHub и слишком большой ответ дают объяснимый отказ', async () => {
    await assert.rejects(resolveRepositorySource({url: 'https://github.com/owner/repo'}, {fetch: async () => Response.json({}, {status: 403})}), /ограничил запросы/);
    await assert.rejects(resolveRepositorySource({url: 'https://github.com/owner/repo'}, {fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))}), /допустимый размер/);
});

test('Декларация runtime имеет приоритет перед package.json и сохраняет SHA исходных байтов из выбранной папки', async () => {
    const manifestRaw = JSON.stringify(toolManifest, null, 2) + '\n';
    const f = fixture({manifestRaw, packageFile: {type: 'symlink'}});
    const result = await resolveRepositorySource({url: 'https://github.com/owner/repo/tree/main/packages/tool'}, {fetch: f.fetch});
    assert.deepEqual(result, {url: 'https://github.com/owner/repo', commit, ref: 'main', subdirectory: 'packages/tool', entrypoint: 'neurocenter.tool.json',
        candidates: ['neurocenter.tool.json'], name: toolManifest.name, description: toolManifest.description, recommendedKind: 'mcp', adapter: 'python',
        supportedTargets: ['darwin-arm64'], runtimeSource, manifestSha256: createHash('sha256').update(manifestRaw).digest('hex')});
    assert.ok(f.requests.every(request => !request.url.pathname.endsWith('package.json')));
    assert.ok(f.requests.slice(2).every(request => request.url.searchParams.get('ref') === commit));
});

test('Уточнённый manifest всё равно читается целиком перед enqueue, даже когда метаданные отключены', async () => {
    const f = fixture({manifest: toolManifest});
    const result = await resolveRepositorySource({url: 'https://github.com/owner/repo', entrypoint: 'neurocenter.tool.json'}, {fetch: f.fetch, metadata: false});
    assert.deepEqual(result.runtimeSource, runtimeSource);
    assert.equal(f.requests.length, 3);
    const invalid = fixture({manifest: {...toolManifest, source: {...runtimeSource, command: 'python main.py'}}});
    await assert.rejects(resolveRepositorySource({url: 'https://github.com/owner/repo', entrypoint: 'neurocenter.tool.json'}, {fetch: invalid.fetch, metadata: false}), /runtime/);
});

test('Повреждённый manifest не скрывается переходом к JS и отклоняет ссылки, размер и неверный UTF-8', async () => {
    for (const options of [
        {manifestRaw: '{invalid'},
        {manifest: {...toolManifest, kind: 'mcp'}},
        {manifest: {...toolManifest, schemaVersion: 2}},
        {manifestFile: {type: 'symlink', encoding: 'base64', content: 'e30=', size: 2}},
        {manifestFile: {type: 'file', encoding: 'base64', content: 'e30=', size: 65537}},
        {manifestFile: {type: 'file', encoding: 'base64', content: Buffer.from([0xff]).toString('base64'), size: 1}},
    ]) {const f = fixture(options); await assert.rejects(resolveRepositorySource({url: 'https://github.com/owner/repo'}, {fetch: f.fetch}), /neurocenter\.tool\.json/);}
    assert.throws(() => validateRepositoryManifest(Buffer.alloc(65537)), /64 КиБ/);
    assert.throws(() => validateRepositoryManifest(JSON.stringify({...toolManifest, source: {...runtimeSource, assets: {}}})), /runtime/);
});

test('HTTP не может подменить runtime, а закреплённый manifest требует согласованную пару source и SHA', () => {
    const pinned = {type: 'repository', url: 'https://github.com/owner/repo', commit, entrypoint: 'neurocenter.tool.json', runtimeSource, manifestSha256: 'b'.repeat(64)};
    assert.deepEqual(validateRepositorySource(pinned), pinned);
    assert.deepEqual(validateRepositorySource({type: 'repository', url: pinned.url, entrypoint: pinned.entrypoint}, {pinned: false}),
        {type: 'repository', url: pinned.url, entrypoint: pinned.entrypoint});
    for (const source of [{...pinned, runtimeSource: undefined}, {...pinned, manifestSha256: undefined}, {...pinned, entrypoint: 'index.ts'}, {...pinned, manifestSha256: 'abc'}]) {
        assert.throws(() => validateRepositorySource(source), /Источник manifest/);
    }
    assert.throws(() => validateRepositorySource({...pinned, commit: undefined}, {pinned: false}), /неподдерживаемые поля/);
    assert.throws(() => validateRepositorySource({...pinned, entrypoint: 'sub/neurocenter.tool.json'}), /JS\/TS/);
});

test('Явно выбранный JS-файл сохраняет поведение даже рядом с runtime manifest', async () => {
    const f = fixture({manifest: toolManifest});
    const result = await resolveRepositorySource({url: 'https://github.com/owner/repo', entrypoint: 'src/index.ts'}, {fetch: f.fetch});
    assert.equal(result.entrypoint, 'src/index.ts');
    assert.equal(result.runtimeSource, undefined);
});
