import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { install } from '../src/bridge/installer.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { assetBase, assetKey, mcpConfigKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { canonicalV4, verify, type Package } from '../src/bridge/package.js';
import { hash, stateDir } from '../src/bridge/state.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { ensureRuntimeArtifact } from '../src/features/runtime-artifacts/cache.js';
import { normalizeRuntimeArtifacts, runtimeArtifactTarget, type RuntimeArtifact } from '../src/features/runtime-artifacts/model.js';
import { workspaceFixture } from './bridge-fixture.js';

interface ReadyTool {
    key: string;
    publication: { name: string; kind: 'mcp' | 'plugin'; revision: string; config: Package['config']; files?: Array<{path: string; content: string}> };
    artifacts: Array<{archivePath: string; descriptorPath: string}>;
}
interface ReadyCase { label: string; directory: string; tool: ReadyTool }
const requested = process.env.NEUROCENTER_CATALOG_READY;
const noop = async (): Promise<void> => undefined;

/** Большие реальные пакеты подключаются явно; обычный unit-прогон их не собирает и не скачивает. */
async function readyCases(value: string): Promise<ReadyCase[]> {
    const filenames: unknown = value.trim().startsWith('[') ? JSON.parse(value) : value.split(path.delimiter);
    if (!Array.isArray(filenames) || !filenames.length || filenames.some(filename => typeof filename !== 'string' || !filename.trim())) {
        throw new Error('NEUROCENTER_CATALOG_READY: нужны пути manifest через path.delimiter или JSON-массив.');
    }
    const cases: ReadyCase[] = [];
    for (const filename of filenames as string[]) {
        const absolute = await fs.realpath(path.resolve(filename));
        const manifest = JSON.parse(await fs.readFile(absolute, 'utf8')) as {schemaVersion: number; tools: ReadyTool[]};
        if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tools) || !manifest.tools.length) { throw new Error('Неизвестный формат ready manifest.'); }
        cases.push(...manifest.tools.map(tool => ({ label: `${tool.key}@${tool.publication.revision}`, directory: path.dirname(absolute), tool })));
    }
    return cases;
}

function deliveryPackage(tool: ReadyTool): Package {
    const files = (tool.publication.files ?? []).map(file => ({ ...file, size: Buffer.byteLength(file.content), sha256: hash(file.content) }));
    const prepared = normalizeRuntimeArtifacts(tool.publication.config?.extra?.runtimeArtifacts).length > 0 || tool.publication.config?.extra?.localConfiguration !== undefined;
    const pkg: Package = { schemaVersion: prepared ? 5 : 4, plugin: { id: `catalog-ready-${tool.key}`, name: tool.publication.name,
        kind: tool.publication.kind, version: 1 }, config: structuredClone(tool.publication.config), files, manifest: { sha256: '', filesCount: files.length } };
    pkg.manifest.sha256 = hash(JSON.stringify(canonicalV4({ schemaVersion: pkg.schemaVersion, plugin: pkg.plugin, config: pkg.config,
        files: files.map(({path, size, sha256}) => ({path, size, sha256})).sort((a, b) => a.path === b.path ? 0 : a.path < b.path ? -1 : 1) })));
    verify(pkg);
    return pkg;
}

async function nativeArchive(item: ReadyCase, expected: RuntimeArtifact): Promise<string> {
    for (const artifact of item.tool.artifacts) {
        const descriptor = JSON.parse(await fs.readFile(path.resolve(item.directory, artifact.descriptorPath), 'utf8')) as RuntimeArtifact;
        if (descriptor.target !== expected.target) { continue; }
        expect(descriptor).toEqual(expected);
        return fs.realpath(path.resolve(item.directory, artifact.archivePath));
    }
    throw new Error(`${item.label}: нет готового архива ${expected.target}.`);
}

async function snapshot(root: string): Promise<Record<string, string>> {
    const entries = await fs.readdir(root, {recursive: true});
    const files: Record<string, string> = {};
    for (const relative of entries.sort()) {
        const filename = path.join(root, relative);
        if ((await fs.lstat(filename)).isFile()) { files[relative] = hash(await fs.readFile(filename)); }
    }
    return files;
}

const cases = requested ? await readyCases(requested) : [];
describe.runIf(Boolean(requested))('Реальные готовые инструменты каталога в изолированном проекте', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    beforeEach(async () => {
        fixture = await workspaceFixture();
        const home = path.join(fixture.temporary, 'home');
        await fs.mkdir(home);
        vi.stubEnv('HOME', home);
        vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
    });
    afterEach(async () => {
        vi.restoreAllMocks(); vi.unstubAllEnvs();
        if (fixture) { await fs.rm(fixture.temporary, {recursive: true, force: true}); }
    });

    for (const item of cases) {
        it(`${item.label}: загрузка, установка, повтор, проверка и удаление сохраняют личный JSONC`, async () => {
            const pkg = deliveryPackage(item.tool);
            const artifacts = normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts);
            const descriptor = artifacts.find(value => value.target === runtimeArtifactTarget());
            if (artifacts.length) { expect(descriptor, `Нет пакета для ${runtimeArtifactTarget()}`).toBeDefined(); }
            const archive = descriptor ? await nativeArchive(item, descriptor) : undefined;
            const personal = {model: 'local/personal', plugin: ['file:///personal/plugin.mjs'],
                mcp: {personal: {type: 'local', command: ['personal-binary']}}, instructions: ['AGENTS.md']};
            const configPath = path.join(fixture.root, 'opencode.jsonc');
            await fs.writeFile(configPath, `// Личные настройки сохраняются\n${JSON.stringify(personal, null, 2)}\n`);

            const download = vi.fn(async () => {
                if (!archive) { throw new Error('Текстовому пакету не нужна загрузка архива.'); }
                return createReadStream(archive);
            });
            const runtime = await ensureRuntimeArtifact(pkg, {download});
            if (descriptor) {
                expect(runtime?.root.startsWith(path.join(stateDir(), 'runtime-artifacts') + path.sep)).toBe(true);
                expect(runtime?.root.startsWith(fixture.temporary + path.sep)).toBe(true);
                expect(runtime?.entrypoint).toBe(path.join(runtime!.root, descriptor.entrypoint));
            } else { expect(runtime).toBeUndefined(); }
            const entrypoint = runtime?.entrypoint ?? path.join(fixture.root, assetBase(pkg), pkg.config!.entrypoint!);
            const installed = await install('test-project', pkg, noop, noop);
            expect(installed).toMatchObject({changed: true, manifest: pkg.manifest.sha256, readiness: 'unverified'});
            const config = parse(await fs.readFile(configPath, 'utf8'));
            if (pkg.plugin.kind === 'plugin') {
                expect(config.plugin).toEqual([...personal.plugin, pathToFileURL(entrypoint).href]);
            } else {
                const connection = config.mcp[mcpConfigKey(pkg)];
                expect(connection.type).toBe('local');
                expect(path.isAbsolute(connection.command[0])).toBe(true);
                if (pkg.config?.extra?.localConfiguration) {
                    expect(connection.command[0]).toBe(process.execPath);
                    expect(connection.command[1]).toMatch(/local-configuration[/\\]launcher-cli\.js$/);
                    expect(connection.command.slice(2)).toEqual([fixture.root, assetKey(pkg), pkg.manifest.sha256]);
                } else {
                    expect(connection.command).toEqual([...(descriptor?.executable ? [] : [process.execPath]), entrypoint, ...(pkg.config?.args ?? [])]);
                }
            }
            expect(await inspectInstallation('test-project', pkg)).toMatchObject({state: 'checked', status: 'synced', issues: [], readiness: 'unverified'});
            const installedSnapshot = await snapshot(fixture.root);
            expect(await ensureRuntimeArtifact(pkg, {download})).toEqual(runtime);
            expect(download).toHaveBeenCalledTimes(descriptor ? 1 : 0);
            expect(await install('test-project', pkg, noop, noop)).toMatchObject({changed: false});
            expect(await snapshot(fixture.root)).toEqual(installedSnapshot);

            expect(await uninstall('test-project', pkg, noop, noop)).toMatchObject({changed: true, manifest: pkg.manifest.sha256});
            const source = await fs.readFile(configPath, 'utf8');
            expect(source).toContain('// Личные настройки сохраняются');
            expect(parse(source)).toEqual(personal);
            await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
            if (runtime) { expect(hash(await fs.readFile(path.join(runtime.root, '.neurocenter-runtime-archive.tar.gz')))).toBe(descriptor!.sha256); }
            expect(await uninstall('test-project', pkg, noop, noop)).toMatchObject({changed: false});
        }, 300_000);
    }

    if (!requested) { it.skip('Нужен NEUROCENTER_CATALOG_READY с путями реальных ready manifest', noop); }
});
