import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';
import { install } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { assetBase, assetKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { LEDGER_PATH } from '../src/bridge/installation-ledger.js';
import { canonicalV4, type Package } from '../src/bridge/package.js';
import { hash, stateDir } from '../src/bridge/state.js';
import { ensureRuntimeArtifact } from '../src/features/runtime-artifacts/cache.js';
import { runtimeArtifactTarget } from '../src/features/runtime-artifacts/model.js';
import { workspaceFixture } from './bridge-fixture.js';

const noop = async (): Promise<void> => undefined;

function preparedPlugin(descriptor: ReturnType<typeof artifactFixture>['descriptor'], id = 'prepared-plugin'): Package {
    const content = 'Управляемое описание готового плагина';
    const pkg: Package = {
        schemaVersion: 5,
        plugin: { id, name: id, kind: 'plugin', version: 1 },
        config: { extra: { runtimeArtifacts: [descriptor] } },
        files: [{ path: 'README.md', content, size: Buffer.byteLength(content), sha256: hash(content) }],
        manifest: { sha256: '', filesCount: 1 },
    };
    pkg.manifest.sha256 = hash(JSON.stringify(canonicalV4({
        schemaVersion: pkg.schemaVersion,
        plugin: pkg.plugin,
        config: pkg.config,
        files: pkg.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    })));
    return pkg;
}

async function snapshot(root: string): Promise<Record<string, string>> {
    const files = await fs.readdir(root, { recursive: true });
    const result: Record<string, string> = {};
    for (const relative of files.sort()) {
        const filename = path.join(root, relative);
        if ((await fs.lstat(filename)).isFile()) { result[relative] = (await fs.readFile(filename)).toString('base64'); }
    }
    return result;
}

describe('Удаление готового плагина из неизменяемого кэша', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await fs.rm(fixture.temporary, { recursive: true, force: true });
    });

    async function installed() {
        const archive = artifactFixture([
            { path: 'first/plugin.mjs', content: 'export default async () => ({});' },
            { path: 'second/plugin.mjs', content: 'export default async () => ({});' },
        ], runtimeArtifactTarget());
        const pkg = preparedPlugin(archive.descriptor);
        const runtime = (await ensureRuntimeArtifact(pkg, { download: async () => Readable.from([archive.archive]) }))!;
        const result = await install('test-project', pkg, noop, noop);
        expect(result.readiness).toBe('unverified');
        return { pkg, runtime, descriptor: archive.descriptor };
    }

    it('Удаляет подключение и квитанцию без config.entrypoint, сохраняя JSONC, соседний плагин и общий кэш', async () => {
        const configPath = path.join(fixture.root, 'opencode.jsonc');
        await fs.writeFile(configPath, '// Личные настройки\n{"model":"local/test","plugin":["personal-plugin"]}\n');
        const { pkg, runtime, descriptor } = await installed();
        const other = preparedPlugin({ ...descriptor, entrypoint: 'second/plugin.mjs' }, 'other-plugin');
        await install('test-project', other, noop, noop);
        const cacheBefore = await snapshot(runtime.root);
        const otherUrl = pathToFileURL(path.join(runtime.root, 'second/plugin.mjs')).href;

        const result = await uninstall('test-project', pkg, noop, noop);

        expect(result).toMatchObject({ changed: true, files: 1, manifest: pkg.manifest.sha256 });
        const source = await fs.readFile(configPath, 'utf8');
        expect(source).toContain('// Личные настройки');
        expect(parse(source)).toEqual({ model: 'local/test', plugin: ['personal-plugin', otherUrl] });
        await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
        await expect(fs.access(path.join(fixture.root, assetBase(pkg), 'README.md'))).rejects.toThrow();
        expect(await fs.readFile(path.join(fixture.root, assetBase(other), 'README.md'), 'utf8')).toBe(other.files[0]!.content);
        const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, LEDGER_PATH), 'utf8'));
        expect(ledger.roots[assetKey(pkg)]).toBeUndefined();
        expect(ledger.roots[assetKey(other)]).toBeDefined();
        expect(await snapshot(runtime.root)).toEqual(cacheBefore);
        expect(JSON.parse(await fs.readFile(result.recoveryPath, 'utf8')).state).toBe('committed');
        expect(await uninstall('test-project', pkg, noop, noop)).toMatchObject({ changed: false, recoveryPath: result.recoveryPath });

        await uninstall('test-project', other, noop, noop);
        expect(parse(await fs.readFile(configPath, 'utf8')).plugin).toEqual(['personal-plugin']);
        expect(await snapshot(runtime.root)).toEqual(cacheBefore);
    });

    it.each(['receipt', 'configuration'])('Подмена %s не удаляет квитанцию, проектные файлы и кэш', async target => {
        const { pkg, runtime } = await installed();
        const otherUrl = pathToFileURL(path.join(runtime.root, 'second/plugin.mjs')).href;
        const filename = path.join(fixture.root, target === 'receipt' ? receiptPath(pkg) : 'opencode.json');
        const value = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (target === 'receipt') { value.config.value = otherUrl; }
        else { value.plugin[0] = otherUrl; }
        await fs.writeFile(filename, JSON.stringify(value));
        const projectBefore = await snapshot(fixture.root);
        const cacheBefore = await snapshot(runtime.root);
        const authorize = vi.fn(noop);

        await expect(uninstall('test-project', pkg, authorize, noop)).rejects.toThrow(
            target === 'receipt' ? 'Путь плагина в квитанции изменён' : 'Путь плагина изменён вручную',
        );

        expect(authorize).not.toHaveBeenCalled();
        expect(await snapshot(fixture.root)).toEqual(projectBefore);
        expect(await snapshot(runtime.root)).toEqual(cacheBefore);
    });

    it('Отсутствие кэша не мешает удалить доказанное подключение сломанного плагина', async () => {
        const { pkg, runtime } = await installed();
        await fs.rm(runtime.root, { recursive: true });

        expect(await uninstall('test-project', pkg, noop, noop)).toMatchObject({ changed: true });

        expect(parse(await fs.readFile(path.join(fixture.root, 'opencode.json'), 'utf8')).plugin).toEqual([]);
        await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });

    it('Ошибка после изменения подключения откатывает конфигурацию, файлы и реестр, сохраняя готовый архив', async () => {
        const { pkg, runtime } = await installed();
        const projectBefore = await snapshot(fixture.root);
        const cacheBefore = await snapshot(runtime.root);
        const remove = fs.rm.bind(fs);
        const receipt = path.join(fixture.root, receiptPath(pkg));
        let injected = false;
        vi.spyOn(fs, 'rm').mockImplementation(async (filename, options) => {
            if (filename === receipt && !injected) {
                injected = true;
                expect(parse(await fs.readFile(path.join(fixture.root, 'opencode.json'), 'utf8')).plugin).toEqual([]);
                await expect(fs.access(path.join(fixture.root, assetBase(pkg), 'README.md'))).rejects.toThrow();
                throw Object.assign(new Error('Диск недоступен'), { code: 'ENOSPC' });
            }
            await remove(filename, options);
        });

        await expect(uninstall('test-project', pkg, noop, noop)).rejects.toMatchObject({ code: 'ENOSPC' });

        expect(injected).toBe(true);
        expect(await snapshot(fixture.root)).toEqual(projectBefore);
        expect(await snapshot(runtime.root)).toEqual(cacheBefore);
        const journalDirectory = path.join(stateDir(), 'file-changes', hash(fixture.root));
        await expect(fs.access(path.join(journalDirectory, 'pending.json'))).rejects.toThrow();
        const history = await fs.readdir(path.join(journalDirectory, 'history'));
        const journals = await Promise.all(history.map(async filename => JSON.parse(await fs.readFile(path.join(journalDirectory, 'history', filename), 'utf8'))));
        expect(journals.some(journal => journal.action === 'uninstall' && journal.state === 'rolled-back')).toBe(true);
        expect(await uninstall('test-project', pkg, noop, noop)).toMatchObject({ changed: true });
    });
});
