import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverCompletions, pendingCompletions, previousDeviceCompletions, saveCompletion } from '../src/bridge/completions.js';
import { install } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { jobContext, stateDir, hash, writeState } from '../src/bridge/state.js';
import { recoverFileJobs } from '../src/bridge/installation-files.js';
import { assetBase } from '../src/bridge/installation-receipt.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

describe('Устойчивое подтверждение локальной установки', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => {
        vi.restoreAllMocks(); vi.unstubAllEnvs();
        await fs.rm(fixture.temporary, { recursive: true, force: true });
    });
    it('Потеря запроса сохраняет успешный результат; повтор отправляет отчёт без изменения файлов', async () => {
        const pkg = packageFixture('mcp');
        const job = { id: randomUUID(), lease: randomUUID() };
        await jobContext.run(job, () => install('test-project', pkg, async () => undefined, async () => undefined));
        const target = path.join(fixture.root, assetBase(pkg), pkg.files[0].path);
        const before = await fs.stat(target);
        await expect(deliverCompletions(async () => { throw new Error('Нет сети'); })).rejects.toThrow('Нет сети');
        const pending = await pendingCompletions();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ ...job, state: 'succeeded', result: { manifest: pkg.manifest.sha256, readiness: 'unverified' } });
        const send = vi.fn(async () => ({ ok: true }));
        await deliverCompletions(send);
        expect(send).toHaveBeenCalledTimes(1);
        expect(await pendingCompletions()).toEqual([]);
        expect((await fs.stat(target)).mtimeMs).toBe(before.mtimeMs);
    });
    it('Восстанавливает результат после фиксации файлов до создания подтверждения', async () => {
        const pkg = packageFixture('skill');
        const original = fs.rename.bind(fs);
        const directory = path.join(stateDir(), 'file-changes', hash(fixture.root));
        // Сбой на архивировании: committed-журнал уже записан и должен пережить перезапуск.
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(to).includes('/completions/')) { throw new Error('Диск временно недоступен'); }
            return original(from, to);
        });
        await expect(jobContext.run({ id: randomUUID(), lease: randomUUID() }, () =>
            install('test-project', pkg, async () => undefined, async () => undefined),
        )).rejects.toThrow('Файлы зафиксированы');
        expect(JSON.parse(await fs.readFile(path.join(directory, 'pending.json'), 'utf8')).state).toBe('committed');
        vi.restoreAllMocks();
        await recoverFileJobs();
        expect((await pendingCompletions())[0]?.state).toBe('succeeded');
        await expect(fs.access(path.join(directory, 'pending.json'))).rejects.toThrow();
        expect(await fs.readFile(path.join(fixture.root, assetBase(pkg), 'SKILL.md'), 'utf8')).toBe(pkg.files[0].content);
    });
    it('Удаление также сохраняет результат с исходным манифестом для сверки после обрыва', async () => {
        const pkg = packageFixture('plugin');
        await install('test-project', pkg, async () => undefined, async () => undefined);
        await jobContext.run({ id: randomUUID(), lease: randomUUID() }, () =>
            uninstall('test-project', pkg, async () => undefined, async () => undefined));
        expect((await pendingCompletions())[0]).toMatchObject({ state: 'succeeded', result: { manifest: pkg.manifest.sha256, changed: true } });
    });
    it('Настоящий SIGKILL после фиксации не теряет подтверждение и не перезаписывает файлы при восстановлении', async () => {
        const pkg = packageFixture('skill');
        const pending = path.join(stateDir(), 'file-changes', hash(fixture.root), 'pending.json');
        const installer = pathToFileURL(path.resolve('src/bridge/installer.ts')).href;
        const context = pathToFileURL(path.resolve('src/bridge/state.ts')).href;
        const job = { id: randomUUID(), lease: randomUUID() };
        const source = `import fs from 'node:fs/promises';import {install} from ${JSON.stringify(installer)};import {jobContext} from ${JSON.stringify(context)};const rename=fs.rename.bind(fs);fs.rename=async(a,b)=>{await rename(a,b);if(b===${JSON.stringify(pending)})process.kill(process.pid,'SIGKILL');};await jobContext.run(${JSON.stringify(job)},()=>install('test-project',${JSON.stringify(pkg)},async()=>undefined,async()=>undefined));`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env: process.env, stdio: 'ignore' });
        const [, signal] = await once(child, 'exit'); expect(signal).toBe('SIGKILL');
        const target = path.join(fixture.root, assetBase(pkg), 'SKILL.md'); const before = (await fs.stat(target)).mtimeMs;
        await recoverFileJobs(); await recoverFileJobs();
        expect((await pendingCompletions())[0]).toMatchObject({ ...job, state: 'succeeded' });
        expect((await fs.stat(target)).mtimeMs).toBe(before);
    }, 15000);
    it('Результаты отозванного подключения сохраняются отдельно и не блокируют новый компьютер', async () => {
        const pkg = packageFixture('skill');
        await jobContext.run({ id: randomUUID(), lease: randomUUID(), deviceId: randomUUID() }, () => install('test-project', pkg, async () => undefined, async () => undefined));
        await writeState('credentials', { deviceId: randomUUID(), email: 'fixture@example.test', token: 'a'.repeat(64) });
        const send = vi.fn(); await deliverCompletions(send);
        expect(send).not.toHaveBeenCalled(); expect(await pendingCompletions()).toEqual([]);
        expect(await previousDeviceCompletions()).toBe(1);
        expect(await fs.readFile(path.join(fixture.root, assetBase(pkg), 'SKILL.md'), 'utf8')).toBe(pkg.files[0].content);
    });
    it('Открытие отчёта сохраняет opened и сообщение на всём пути save → pending → deliver', async () => {
        const completion = { id: randomUUID(), lease: randomUUID(), state: 'succeeded' as const,
            message: 'Полное сравнение открыто на подключённом компьютере.',
            result: { projectId: 'test-project', bindingId: 'a'.repeat(64), changePlanId: randomUUID(), digest: 'b'.repeat(64), opened: true } };
        await saveCompletion(completion);
        expect(await pendingCompletions()).toEqual([completion]);
        const send = vi.fn(async item => {
            expect(item).toEqual(completion);
            expect(Object.keys(item.result).sort()).toEqual(['projectId', 'bindingId', 'changePlanId', 'digest', 'opened'].sort());
            expect(item.result.opened).toBe(true);
        });
        await deliverCompletions(send); expect(send).toHaveBeenCalledOnce(); expect(await pendingCompletions()).toEqual([]);
    });
    it.each(['succeeded', 'failed'] as const)('Квитанция apply %s скрывает note, recoveryPath и посторонние данные до сохранения и доставки', async state => {
        const result = { projectId: 'test-project', assetId: 'ai-plug-fixture', version: 1, manifest: 'a'.repeat(64), bindingId: 'b'.repeat(64),
            changePlanId: randomUUID(), digest: 'c'.repeat(64), files: 1, changed: state === 'succeeded', readiness: 'unverified',
            ...(state === 'failed' ? { unchanged: true } : {}) };
        const message = state === 'succeeded' ? 'Локальное действие завершено; предыдущее состояние сохранено.' : 'Локальное действие не выполнено; предыдущее состояние сохранено.';
        await saveCompletion({ id: randomUUID(), lease: randomUUID(), state, message: 'Секретное сообщение: private-token',
            result: { ...result, note: 'private-token', recoveryPath: path.join(fixture.temporary, 'private-history'), stdout: 'private-token', unknown: { secret: 'private-token' } } });
        const pending = await pendingCompletions(); expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ state, message, result });
        expect(pending[0]!.result).toEqual(result); expect(JSON.stringify(pending)).not.toContain('private-token'); expect(JSON.stringify(pending)).not.toContain(fixture.temporary);
        const send = vi.fn(async item => { expect(item.result).toEqual(result); expect(item.message).toBe(message); });
        await deliverCompletions(send); expect(send).toHaveBeenCalledOnce(); expect(await pendingCompletions()).toEqual([]);
    });
});
