import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';
import { ensureRuntimeArtifact, resolvePreparedRuntimeArtifact } from '../src/features/runtime-artifacts/cache.js';
import { runtimeArtifactTarget } from '../src/features/runtime-artifacts/model.js';
import { canonicalV4, type Package } from '../src/bridge/package.js';
import { hash, stateDir } from '../src/bridge/state.js';
import { install } from '../src/bridge/installer.js';
import { prepareLocalChange, applyLocalChange } from '../src/bridge/local-change-plan.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { workspaceFixture } from './bridge-fixture.js';

const noop = async () => {};
describe('Явное восстановление готового кэша по подтверждённому плану', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let archive: Buffer;
    let pkg: Package;
    let root: string;
    let entrypoint: string;
    beforeEach(async () => {
        fixture = await workspaceFixture();
        const ready = artifactFixture(undefined, runtimeArtifactTarget()); archive = ready.archive;
        pkg = { schemaVersion: 5, plugin: { id: 'cache-repair', name: 'cache-repair', kind: 'mcp', version: 1 },
            config: { transport: 'local', extra: { runtimeArtifacts: [ready.descriptor] } }, files: [], manifest: { sha256: '', filesCount: 0 } };
        pkg.manifest.sha256 = hash(JSON.stringify(canonicalV4({ schemaVersion: 5, plugin: pkg.plugin, config: pkg.config, files: [] })));
        const prepared = await ensureRuntimeArtifact(pkg, { download: async () => Readable.from([archive]) });
        root = prepared!.root; entrypoint = prepared!.entrypoint;
        await install('test-project', pkg, noop, noop);
        await fs.chmod(entrypoint, 0o600); await fs.writeFile(entrypoint, 'Ручные повреждённые байты кэша');
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it('Preview не пишет кэш, cache-only apply требует подтверждение и сохраняет карантин исходных байтов', async () => {
        const before = await fs.readFile(path.join(fixture.root, 'opencode.json'));
        const download = vi.fn(async () => Readable.from([archive]));
        await expect(resolvePreparedRuntimeArtifact(pkg)).rejects.toThrow(/изменены/);
        await expect(ensureRuntimeArtifact(pkg, { download })).rejects.toThrow(/изменены/);
        const plan = await prepareLocalChange('test-project', pkg, undefined, noop);
        expect(plan.runtimeRepairRequired).toBe(true); expect(plan.files).toEqual([]);
        expect(download).not.toHaveBeenCalled(); expect(await fs.readFile(entrypoint, 'utf8')).toBe('Ручные повреждённые байты кэша');
        const options = { planId: plan.planId, revision: 1 as const, digest: plan.digest, expectedBindingId: plan.bindingId };
        await expect(applyLocalChange('test-project', pkg, options, async () => { throw new Error('Отозвано'); }, noop,
            async () => { await ensureRuntimeArtifact(pkg, { download, repairCorrupt: true }); })).rejects.toThrow(/Отозвано/);
        expect(download).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(fixture.root, 'opencode.json'))).toEqual(before);
        const result = await applyLocalChange('test-project', pkg, options, noop, noop,
            async () => { await ensureRuntimeArtifact(pkg, { download, repairCorrupt: true, beforeCommit: noop }); });
        expect(result.changed).toBe(true); expect(download).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(path.join(fixture.root, 'opencode.json'))).toEqual(before);
        expect((await inspectInstallation('test-project', pkg)).status).toBe('synced');
        const quarantine = (await fs.readdir(path.dirname(root))).find(name => name.startsWith('.quarantine-'));
        expect(quarantine).toBeTruthy();
        expect(await fs.readFile(path.join(path.dirname(root), quarantine!, path.relative(root, entrypoint)), 'utf8')).toBe('Ручные повреждённые байты кэша');
    });

    it.each(['offline', 'sha', 'revoke'])('Отказ %s сохраняет повреждённый кэш и проект без публикации частичного refetch', async failure => {
        const before = await fs.readFile(path.join(fixture.root, 'opencode.json'));
        const beforeCache = await fs.readFile(entrypoint);
        const download = vi.fn(async () => failure === 'offline' ? Readable.from((async function* () { yield archive.subarray(0, 4); throw new Error('Offline'); })())
            : Readable.from([failure === 'sha' ? Buffer.from('tampered') : archive]));
        const plan = await prepareLocalChange('test-project', pkg, undefined, noop);
        await expect(applyLocalChange('test-project', pkg, { planId: plan.planId, revision: 1, digest: plan.digest, expectedBindingId: plan.bindingId }, noop, noop,
            async () => { await ensureRuntimeArtifact(pkg, { repairCorrupt: true, download,
                beforeCommit: async () => { if (failure === 'revoke') { throw new Error('Отозвано после fetch'); } },
            }); })).rejects.toThrow();
        expect(download).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(entrypoint)).toEqual(beforeCache); expect(await fs.readFile(path.join(fixture.root, 'opencode.json'))).toEqual(before);
        expect((await fs.readdir(path.dirname(root))).filter(name => name !== path.basename(root))).toEqual([]);
        await expect(resolvePreparedRuntimeArtifact(pkg)).rejects.toThrow();
        if (failure === 'offline') {
            await applyLocalChange('test-project', pkg, { planId: plan.planId, revision: 1, digest: plan.digest, expectedBindingId: plan.bindingId }, noop, noop,
                async () => { await ensureRuntimeArtifact(pkg, { repairCorrupt: true, download: async () => Readable.from([archive]) }); });
            expect((await inspectInstallation('test-project', pkg)).status).toBe('synced');
            expect(await fs.readFile(path.join(fixture.root, 'opencode.json'))).toEqual(before);
        }
    });

    it('Ошибка публикации после карантина откатывает исходный каталог, не теряя байты', async () => {
        const rename = fs.rename.bind(fs); let blocked = false;
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (!blocked && String(from).endsWith('/payload') && String(to) === root) { blocked = true; throw Object.assign(new Error('Диск заполнен'), { code: 'ENOSPC' }); }
            return rename(from, to);
        });
        await expect(ensureRuntimeArtifact(pkg, { repairCorrupt: true, download: async () => Readable.from([archive]) })).rejects.toThrow(/Диск/);
        expect(blocked).toBe(true); expect(await fs.readFile(entrypoint, 'utf8')).toBe('Ручные повреждённые байты кэша');
        expect((await fs.readdir(path.dirname(root))).filter(name => name !== path.basename(root))).toEqual([]);
    });

    it('Другой владелец кэша блокирует ремонт до сети', async () => {
        const filename = path.join(stateDir(), 'runtime-artifacts/.lock');
        await fs.writeFile(filename, JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', pid: process.pid }));
        const download = vi.fn(async () => Readable.from([archive]));
        await expect(ensureRuntimeArtifact(pkg, { repairCorrupt: true, download })).rejects.toThrow(/Другой процесс/);
        expect(download).not.toHaveBeenCalled();
    });

    it('После аварии между карантином и публикацией возвращает исходный кэш и сохраняет fail-closed чтение', async () => {
        const id = '11111111-1111-4111-8111-111111111111'; const cache = path.dirname(root); const sha256 = path.basename(root);
        const stage = path.join(cache, '.' + id + '.partial'); const quarantine = '.quarantine-' + sha256 + '-' + id;
        await fs.mkdir(stage, { mode: 0o700 }); await fs.writeFile(path.join(stage, '.owner.json'), JSON.stringify({ schemaVersion: 1, id, pid: 2147483647,
            replacement: { sha256, quarantine } }));
        await fs.rename(root, path.join(cache, quarantine));
        const download = vi.fn(async () => Readable.from([archive]));
        await expect(ensureRuntimeArtifact(pkg, { download })).rejects.toThrow(/изменены/);
        expect(await fs.readFile(entrypoint, 'utf8')).toBe('Ручные повреждённые байты кэша');
        expect(download).not.toHaveBeenCalled(); await expect(fs.stat(stage)).rejects.toThrow(); await expect(fs.stat(path.join(cache, quarantine))).rejects.toThrow();
    });

    it('Карантин и новая копия входят в общий бюджет; нехватка места останавливает ремонт до сети', async () => {
        const reserved = await fs.open(path.join(path.dirname(root), 'reserved'), 'wx'); await reserved.truncate(2 * 1024 ** 3); await reserved.close();
        const download = vi.fn(async () => Readable.from([archive]));
        await expect(ensureRuntimeArtifact(pkg, { repairCorrupt: true, download })).rejects.toThrow(/2 ГиБ/);
        expect(download).not.toHaveBeenCalled(); expect(await fs.readFile(entrypoint, 'utf8')).toBe('Ручные повреждённые байты кэша');
    });

    it('Подмена runtimeRepairRequired в подготовленном плане не разрешает refetch', async () => {
        const plan = await prepareLocalChange('test-project', pkg, undefined, noop);
        const filename = path.join(stateDir(), 'local-change-plans', plan.planId + '.json');
        const saved = JSON.parse(await fs.readFile(filename, 'utf8')); delete saved.summary.runtimeRepairRequired; await fs.writeFile(filename, JSON.stringify(saved));
        const prepareRuntime = vi.fn(async () => {});
        await expect(applyLocalChange('test-project', pkg, { planId: plan.planId, revision: 1, digest: plan.digest, expectedBindingId: plan.bindingId }, noop, noop, prepareRuntime)).rejects.toThrow();
        expect(prepareRuntime).not.toHaveBeenCalled();
    });
});
