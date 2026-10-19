import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { run } from '../upstream.mjs';

const [directory, engine, output] = process.argv.slice(2).map(value => path.resolve(value));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-snip-engine-'));
let registryRequests = 0;
const registry = http.createServer((_request, response) => { registryRequests++; response.writeHead(503); response.end(); });
await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
const evidence = { status: 'failed', nodeVersion: process.versions.node, engineVersion: '1.14.48', realProfileChanged: false };
try {
    const home = path.join(temporary, 'home');
    const project = path.join(temporary, 'project');
    const config = path.join(home, 'config/opencode');
    for (const dir of [project, config, path.join(config, 'node_modules'), path.join(project, 'node_modules'), path.join(temporary, 'node_modules')]) await fs.mkdir(dir, { recursive: true });
    const lockedDependency = { '@opencode-ai/plugin': '1.14.48' };
    await fs.writeFile(path.join(config, '.gitignore'), 'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n');
    await fs.writeFile(path.join(config, 'package.json'), JSON.stringify({ private: true, dependencies: lockedDependency }));
    await fs.writeFile(path.join(config, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: lockedDependency } } }));
    const bunfig = 'telemetry = false\nenv = false\n[install]\nauto = "disable"\n';
    await fs.writeFile(path.join(project, 'bunfig.toml'), bunfig);
    await fs.writeFile(path.join(home, '.bunfig.toml'), bunfig);
    const marker = path.join(temporary, 'result.json');
    const wrapper = path.join(temporary, 'wrapper.mjs');
    await fs.writeFile(wrapper, `import fs from 'node:fs/promises';import plugin from ${JSON.stringify(pathToFileURL(path.join(directory, 'plugin.mjs')).href)};export default async function(input){const hooks=await plugin(input);await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({hooks:Object.keys(hooks)}),{flag:'wx',mode:0o600});return hooks;}`);
    await fs.writeFile(path.join(config, 'opencode.json'), JSON.stringify({ plugin: [pathToFileURL(wrapper).href], mcp: {}, enabled_providers: [], provider: {}, lsp: false, formatter: false, autoupdate: false, snapshot: false, share: 'disabled', permission: { '*': 'deny' } }));
    const url = `http://127.0.0.1:${registry.address().port}`;
    const env = { HOME: home, USERPROFILE: home, PATH: '', TERM: 'dumb', NO_COLOR: '1',
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
        XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
        OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(temporary, 'managed'), OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        npm_config_registry: url, NPM_CONFIG_REGISTRY: url };
    await fs.chmod(path.join(config, 'node_modules'), 0o500);
    await fs.chmod(config, 0o500);
    const version = await run(engine, ['--version'], { cwd: project, env, timeout: 15_000 });
    assert.equal(version.stdout.trim(), evidence.engineVersion);
    await run(engine, ['debug', 'config'], { cwd: project, env, timeout: 30_000 });
    assert.deepEqual(JSON.parse(await fs.readFile(marker)), { hooks: ['tool.execute.before'] });
    assert.equal(registryRequests, 0);
    evidence.status = 'passed';
    evidence.checks = ['Закреплённый OpenCode 1.14.48 загрузил plugin factory', 'Native snip hook прошёл init внутри OpenCode', 'Обращений к registry нет'];
} catch (error) { evidence.error = error.stack; process.exitCode = 1; }
finally {
    await new Promise(resolve => registry.close(resolve));
    await fs.chmod(path.join(temporary, 'home/config/opencode'), 0o700).catch(() => {});
    await fs.chmod(path.join(temporary, 'home/config/opencode/node_modules'), 0o700).catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
    evidence.temporaryProfileRemoved = true;
    evidence.registryRequests = registryRequests;
    if (output) { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n'); }
    console.log(JSON.stringify(evidence, null, 2));
}
