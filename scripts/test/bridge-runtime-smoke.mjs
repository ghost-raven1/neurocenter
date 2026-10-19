import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-runtime-'));
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
    const node = path.join(content, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const entry = path.join(content, 'dist/index.js');
    const isolatedEnv = { ...process.env, PATH: path.join(temporary, 'empty-path'), HOME: temporary,
        USERPROFILE: temporary, XDG_CONFIG_HOME: path.join(temporary, 'config'),
        NEUROCENTER_URL: 'http://127.0.0.1:1', NEUROCENTER_BRIDGE_HOME: path.join(temporary, 'private') };
    await fs.mkdir(isolatedEnv.PATH);
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
    client = new Client({ name: 'Проверка автономного пакета', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: node, args: [entry], cwd: content, env: isolatedEnv, stderr: 'ignore' }));
    await check('Реальный stdio MCP загружается из готового пакета и сообщает протокол, сборку и LanceDB', async () => {
        const response = await client.callTool({ name: 'neurocenter_bridge_status', arguments: {} });
        assert.notEqual(response.isError, true);
        const status = JSON.parse(response.content.find(item => item.type === 'text').text);
        assert.equal(status.connected, false); assert.equal(status.protocolVersion, 2);
        assert.equal(status.buildId, metadata.buildId); assert.equal(status.runtimeVersion, metadata.nodeVersion);
        assert.equal(status.ragSupported, metadata.ragSupported);
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
