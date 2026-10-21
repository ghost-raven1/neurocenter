import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyBridgeBuild } from '../bridge-build-integrity.mjs';

// Запускаем распакованный артефакт без системных Node/npm и без личного профиля пользователя.
const root = fileURLToPath(new URL('../../', import.meta.url));
const bridgeVersion = JSON.parse(await fs.readFile(path.join(root, 'mcp/neurocenter-asset-sync/package.json'), 'utf8')).version;
const require = createRequire(path.join(root, 'mcp/neurocenter-asset-sync/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const target = `${platform}-${process.arch}${process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : ''}`;
const archive = path.resolve(process.argv[2] || path.join(root, 'bridge-dist/runtime', `neurocenter-asset-sync-${target}-${bridgeVersion}.tgz`));
const reportFile = process.env.BRIDGE_RUNTIME_REPORT || path.join(root, '.run/bridge-validation', bridgeVersion, 'runtime-smoke.json');
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-runtime-')));
const cases = [];
let client, fatal, metadata;
async function check(name, action) { await action(); cases.push(name); console.log('OK ' + name); }
try {
    metadata = JSON.parse(await fs.readFile(archive + '.json', 'utf8'));
    await check('Контрольная сумма готового автономного архива совпадает с манифестом', async () => {
        const digest = createHash('sha256'); for await (const chunk of createReadStream(archive)) digest.update(chunk);
        assert.equal(digest.digest('hex'), metadata.sha256);
        assert.equal((await fs.readFile(archive + '.sha256', 'utf8')).trim(), metadata.sha256);
        assert.equal(metadata.target, target);
    });
    const content = path.join(temporary, 'автономный MCP'); await fs.mkdir(content);
    execFileSync('tar', ['-xzf', archive, '-C', content]);
    await check('Версии descriptor, package, runtime и dist/build совпадают до запуска MCP', async () => {
        assert.equal(metadata.version, bridgeVersion);
        for (const file of ['package.json', 'runtime.json', 'dist/build.json']) {
            const record = JSON.parse(await fs.readFile(path.join(content, file), 'utf8'));
            assert.equal(record.version, bridgeVersion, file);
            if (file !== 'package.json') assert.equal(record.buildId, metadata.buildId, file);
        }
    });
    const node = path.join(content, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const entry = path.join(content, 'dist/index.js');
    const isolatedEnv = { ...process.env, PATH: path.join(temporary, 'empty-path'), HOME: temporary,
        USERPROFILE: temporary, XDG_CONFIG_HOME: path.join(temporary, 'config'),
        NEUROCENTER_URL: 'http://127.0.0.1:1', NEUROCENTER_BRIDGE_HOME: path.join(temporary, 'private') };
    await fs.mkdir(isolatedEnv.PATH);
    await check('Загруженная compiled-программа подтверждает RAG-профиль, полный снимок и buildId', async () => {
        const checked = await verifyBridgeBuild(path.join(content, 'dist'), bridgeVersion);
        assert.equal(checked.buildId, metadata.buildId);
        if (process.env.BRIDGE_EXPECTED_BUILD_ID) assert.equal(checked.buildId, process.env.BRIDGE_EXPECTED_BUILD_ID);
        const code = "const p=await import('./dist/bridge/protocol.js');console.log(JSON.stringify({version:p.BRIDGE_VERSION,protocol:p.BRIDGE_PROTOCOL,capabilities:p.BRIDGE_CAPABILITIES,buildId:await p.bridgeBuildId()}));";
        const loaded = JSON.parse(execFileSync(node, ['--input-type=module', '-e', code], {cwd:content,env:isolatedEnv,encoding:'utf8'}));
        assert.equal(loaded.version, bridgeVersion); assert.equal(loaded.protocol, 2);
        assert.equal(loaded.buildId, metadata.buildId);
        assert.equal(loaded.capabilities.includes('hosted-rag-profile-values-v1'), true);
        assert.equal(loaded.capabilities.includes('project-snapshots-v1'), true);
    });
    await check('Встроенный runtime запускается без Node и npm в PATH', async () => {
        assert.equal(execFileSync(node, ['-p', 'process.versions.node'], { env: isolatedEnv, encoding: 'utf8' }).trim(), metadata.nodeVersion);
        assert.equal((await fs.readFile(path.join(content, 'bin/NODE-LICENSE'), 'utf8')).length > 1000, true);
    });
    const configFile = path.join(isolatedEnv.XDG_CONFIG_HOME, 'opencode/opencode.jsonc');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, '{\n  // Настройка пользователя\n  "model": "fixture/model",\n  "mcp": {"другой": {"type": "remote", "url": "https://example.test/mcp"}}\n}\n');
    await check('Регистрация автономного MCP сохраняет JSONC, другие MCP и повторяется без изменений', async () => {
        const first = JSON.parse(execFileSync(node, [entry, '--init'], { env: isolatedEnv, encoding: 'utf8' }));
        assert.equal(first.node, await fs.realpath(node)); assert.equal(first.indexJs, await fs.realpath(entry)); assert.equal(first.created, false);
        const text = await fs.readFile(configFile, 'utf8');
        assert.ok(text.includes('// Настройка пользователя')); assert.ok(text.includes('fixture/model')); assert.ok(text.includes('https://example.test/mcp'));
        execFileSync(node, [entry, '--init'], { env: isolatedEnv });
        assert.equal(await fs.readFile(configFile, 'utf8'), text);
    });
    await check('Готовый runtime снимает полный LanceDB образ, сохраняя таблицы, схему, индекс и поиск', async () => {
        const own = path.join(temporary, 'snapshot-proof');
        await fs.mkdir(own);
        const proof = JSON.parse(execFileSync(node, [path.join(root, 'scripts/test/bridge-snapshot-runtime.fixture.mjs'), own], {
            cwd: content, env: {...isolatedEnv, NEUROCENTER_BRIDGE_HOME: path.join(own, 'private')}, encoding: 'utf8', timeout: 60000,
        }));
        assert.deepEqual(proof, {tables:3,rows:514,allColumns:true,schemaVersions:true,indexPreserved:true,semanticSearch:true,sourceUnchanged:true,privateFilesExcluded:true});
    });
    client = new Client({ name: 'Проверка автономного пакета', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: node, args: [entry], cwd: content, env: isolatedEnv, stderr: 'ignore' }));
    await check('Реальный stdio MCP загружается из готового пакета и сообщает протокол, сборку и LanceDB', async () => {
        assert.equal(client.getServerVersion()?.version, metadata.version);
        const response = await client.callTool({ name: 'neurocenter_bridge_status', arguments: {} });
        assert.notEqual(response.isError, true);
        const status = JSON.parse(response.content.find(item => item.type === 'text').text);
        assert.equal(status.connected, false); assert.equal(status.protocolVersion, 2);
        assert.equal(status.bridgeVersion, metadata.version);
        assert.equal(metadata.version, bridgeVersion);
        assert.equal(status.buildId, metadata.buildId); assert.equal(status.runtimeVersion, metadata.nodeVersion);
        assert.equal(status.ragSupported, metadata.ragSupported);
        assert.equal(status.capabilities.includes('hosted-rag-profile-values-v1'), true);
        assert.equal(status.capabilities.includes('project-snapshots-v1'), true);
    });
    await check('В артефакте отсутствуют старые команды небезопасной записи', async () => {
        const tools = (await client.listTools()).tools.map(tool => tool.name);
        for (const name of ['install_asset', 'install_plugin_bundle']) {
            assert.equal(tools.includes(name), false);
            assert.equal((await client.callTool({ name, arguments: { targetPath: temporary } })).isError, true);
        }
        await assert.rejects(fs.access(path.join(content, 'dist/tools/install-asset.js')), error => error.code === 'ENOENT');
    });
} catch (error) { fatal = error.stack || String(error); console.error(fatal); process.exitCode = 1; }
finally {
    if (client) await client.close();
    await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(path.dirname(reportFile), { recursive: true });
    await fs.writeFile(reportFile, JSON.stringify({ checkedAt: new Date().toISOString(), archive, metadata, cases, fatal: fatal || null,
        temporaryProfileRemoved: true, realProfileChanged: false }, null, 2) + '\n');
}
