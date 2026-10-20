import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import {readyManifest} from './manifest.mjs';

const require = createRequire(new URL('../../mcp/neurocenter-asset-sync/package.json', import.meta.url));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));

/** Настоящий stdio и операции в одноразовой папке без изменения личного профиля. */
export async function smokeCatalog(manifestFile) {
    const tools=await readyManifest(manifestFile);
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-catalog-smoke-')));
    const report = [];
    try {
        const project = path.join(root, 'project'); const home = path.join(root, 'home'); const tripwire = path.join(root, 'tripwire');
        await Promise.all([fs.mkdir(project), fs.mkdir(home), fs.mkdir(tripwire)]);
        await fs.writeFile(path.join(project, 'hello.txt'), 'Каталог работает');
        await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' }, packageManager: 'npm@10.8.2' }));
        await promisify(execFile)('git', ['init', '--quiet', project], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home } });
        const marker = path.join(root, 'registry-called');
        for (const command of ['npm', 'npx', 'bun', 'pnpm', 'yarn']) await fs.writeFile(path.join(tripwire, command), `#!/bin/sh\nprintf called > '${marker}'\nexit 99\n`, { mode: 0o700 });
        for (const tool of tools) {
            const publication = tool.publication;
            const directory = path.join(root, tool.key); await fs.mkdir(directory);
            let entrypoint;
            if (tool.artifacts.length) {
                const selected = tool.artifacts.find(item => item.descriptor.target==='darwin-arm64');
                if (!selected) { report.push({ key: tool.key, skipped: 'Нет native darwin-arm64 комплекта' }); continue; }
                const descriptor=selected.descriptor;
                await runtime.inspectRuntimeArchive(selected.archivePath, descriptor, { destination: directory });
                entrypoint = path.join(directory, descriptor.entrypoint);
            } else {
                for (const file of publication.files) await fs.writeFile(path.join(directory, file.path), file.content);
                entrypoint = path.join(directory, publication.config.entrypoint);
            }
            if (publication.kind === 'plugin') {
                const plugin = (await import(pathToFileURL(entrypoint))).default;
                if (tool.key === 'opencode-rag-plugin') {
                    // Общий smoke проверяет загрузку без модели; автоиндекс и поиск покрывает native smoke.
                    const config = path.join(project, 'opencode-rag.json');
                    await fs.writeFile(config, JSON.stringify({ embedding: { vectorDimension: 4 }, openCode: { autoIndex: { enabled: false } },
                        description: { enabled: false }, imageDescription: { enabled: false }, logging: { level: 'none' } }), { flag: 'wx' });
                    try {
                        const hooks = await plugin({ directory: project });
                        assert.ok(hooks.tool.search_semantic);
                        assert.ok(hooks.tool.get_file_skeleton);
                        assert.equal(typeof hooks['chat.message'], 'function');
                        report.push({ key: tool.key, initialized: true, hook: true, tools: Object.keys(hooks.tool).length });
                    } finally { await fs.rm(config, { force: true }); }
                    continue;
                }
                const hooks = await plugin({ directory: project });
                if (tool.key === 'opencode-snip') {
                    const output = { args: { command: 'git status' } };
                    await hooks['tool.execute.before']({ tool: 'bash' }, output);
                    assert.notEqual(output.args.command, 'git status');
                    assert.match(output.args.command, /snip/);
                    const complex = { args: { command: 'git status | cat' } };
                    await hooks['tool.execute.before']({ tool: 'bash' }, complex);
                    assert.equal(complex.args.command, 'git status | cat');
                } else {
                    const output = { system: [] };
                    await hooks['experimental.chat.system.transform']({}, output);
                    if (tool.key === 'project-context') assert.match(output.system[0], /test/);
                    if (tool.key === 'git-context') assert.match(output.system[0], /Git/);
                }
                report.push({ key: tool.key, initialized: true, hook: true });
                continue;
            }
            const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint, ...(publication.config.args ?? [])], cwd: project,
                env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, PATH: tripwire, TMPDIR: root }, stderr: 'pipe' });
            let diagnostics = '';
            transport.stderr?.on('data', chunk => { if (diagnostics.length < 4000) diagnostics += chunk.toString(); });
            const client = new Client({ name: 'neurocenter-catalog-smoke', version: '1.0.0' });
            try {
                await client.connect(transport);
                const tools = (await client.listTools()).tools;
                assert.ok(tools.length > 0);
                let result;
                if (tool.key === 'filesystem') {
                    result = await client.callTool({ name: 'read_text_file', arguments: { path: path.join(project, 'hello.txt') } });
                    assert.ok(!result.isError, JSON.stringify(result)); assert.match(JSON.stringify(result), /Каталог работает/);
                    const outside = await client.callTool({ name: 'read_text_file', arguments: { path: path.join(root, 'outside.txt') } });
                    assert.equal(outside.isError, true);
                } else if (tool.key === 'memory') {
                    result = await client.callTool({ name: 'create_entities', arguments: { entities: [{ name: 'Проверка', entityType: 'test', observations: ['catalog'] }] } });
                    assert.ok(!result.isError);
                    assert.match(await fs.readFile(path.join(project, '.opencode/neurocenter-memory/memory.jsonl'), 'utf8'), /Проверка/);
                } else if (tool.key === 'sequential-thinking') {
                    result = await client.callTool({ name: 'sequentialthinking', arguments: { thought: 'Проверяем готовую поставку', thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false } });
                    assert.ok(!result.isError);
                } else if (tool.key === 'opencode-rag') {
                    for (const name of ['search_semantic', 'get_file_skeleton', 'find_usages', 'index_project', 'get_index_status']) assert.ok(tools.some(item => item.name === name));
                    result = await client.callTool({ name: 'get_file_skeleton', arguments: { filePath: '../outside.ts' } });
                    assert.equal(result.isError, true);
                }
                report.push({ key: tool.key, connected: true, tools: tools.length, actualCall: !!result });
            } catch (error) { throw new Error(`${tool.key}: ${error.message}. ${diagnostics}`); }
            finally { await client.close(); await transport.close(); }
        }
        await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
        return { platform: `${process.platform}-${process.arch}`, isolatedProfile: true, registryCalls: 0, tools: report };
    } finally { await fs.rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    if (!process.argv[2]) throw new Error('Укажите asset.json');
    console.log(JSON.stringify(await smokeCatalog(path.resolve(process.argv[2])), null, 2));
}
