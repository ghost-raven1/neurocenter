import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindProject, commitProjectBinding, prepareProjectBinding, projectBindingId, projectFolder, projectInstanceId } from '../src/bridge/workspace.js';
import { readState, stateDir, writeState } from '../src/bridge/state.js';
import { registryFile } from '../src/bridge/workspace-identity-state.js';
import * as atomic from '../src/bridge/atomic-file.js';
import { install } from '../src/bridge/installer.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

describe('Повторное подключение после удаления служебной папки проекта', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const projectId = 'test-project';
    const marker = () => path.join(fixture.root, '.opencode/neurocenter.json');
    const input = () => ({ projectId, folderName: path.basename(fixture.root) });
    const credentials = { deviceId: '11111111-1111-4111-8111-111111111111', token: 'fixture-device-token', email: 'owner@example.test' };
    beforeEach(async () => { fixture = await workspaceFixture(); await writeState('credentials', credentials); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it.each(['вся .opencode', 'только marker', 'часть служебных файлов'])('Восстанавливает прежнюю привязку, если удалена %s', async removed => {
        const instanceId = await projectInstanceId(projectId), bindingId = await projectBindingId(projectId);
        const registry = await fs.readFile(registryFile(), 'utf8');
        if (removed === 'вся .opencode') { await fs.rm(path.join(fixture.root, '.opencode'), { recursive: true }); }
        else {
            await fs.writeFile(path.join(fixture.root, '.opencode/user-settings.json'), '{"theme":"dark"}');
            if (removed === 'часть служебных файлов') { await fs.mkdir(path.join(fixture.root, '.opencode/neurocenter/receipts'), { recursive: true }); }
            await fs.rm(marker());
        }
        const prepared = await prepareProjectBinding(input());
        await expect(fs.stat(marker())).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(commitProjectBinding(prepared)).resolves.toMatchObject({ instanceId, bindingId });
        expect(await projectFolder(projectId)).toBe(fixture.root);
        expect(await projectInstanceId(projectId)).toBe(instanceId); expect(await projectBindingId(projectId)).toBe(bindingId);
        expect(await fs.readFile(registryFile(), 'utf8')).toBe(registry);
        expect(await readState('credentials')).toEqual(credentials);
        if (removed !== 'вся .opencode') { expect(await fs.readFile(path.join(fixture.root, '.opencode/user-settings.json'), 'utf8')).toBe('{"theme":"dark"}'); }
        const restored = await fs.readFile(marker(), 'utf8');
        await bindProject(projectId, path.basename(fixture.root));
        expect(await fs.readFile(marker(), 'utf8')).toBe(restored); expect(await projectBindingId(projectId)).toBe(bindingId);
    });

    it('Восстановление marker сохраняет оставшиеся установки, а удалённые не объявляет готовыми', async () => {
        const pkg = packageFixture(); await install(projectId, pkg, async () => undefined, async () => undefined);
        await fs.rm(marker()); await bindProject(projectId, path.basename(fixture.root));
        expect((await inspectInstallation(projectId, pkg)).status).toBe('synced');
        await fs.rm(path.join(fixture.root, '.opencode'), { recursive: true });
        await bindProject(projectId, path.basename(fixture.root));
        expect((await inspectInstallation(projectId, pkg)).status).not.toBe('synced');
    });

    it('Отказывает другому проекту без изменения приватного реестра и credentials', async () => {
        await fs.rm(marker()); const before = await fs.readFile(registryFile(), 'utf8');
        await expect(prepareProjectBinding({ ...input(), projectId: 'another-project' })).rejects.toMatchObject({ code: 'foreign-binding' });
        expect(await fs.readFile(registryFile(), 'utf8')).toBe(before); expect(await readState('credentials')).toEqual(credentials);
        await expect(fs.stat(marker())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Копия по прежнему пути с другим inode не получает identity оригинала', async () => {
        await fs.rm(marker()); const original = path.join(path.dirname(fixture.root), 'Оригинал');
        await fs.rename(fixture.root, original); await fs.cp(original, fixture.root, { recursive: true });
        await expect(prepareProjectBinding(input())).rejects.toMatchObject({ code: 'marker-missing' });
        await expect(fs.stat(marker())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Переименование исходной папки не подменяется восстановлением marker', async () => {
        await fs.rm(marker()); const renamed = path.join(path.dirname(fixture.root), 'Новое имя'); await fs.rename(fixture.root, renamed);
        await expect(prepareProjectBinding({ ...input(), folderName: path.basename(renamed) })).rejects.toMatchObject({ code: 'marker-missing' });
        await expect(fs.stat(path.join(renamed, '.opencode/neurocenter.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Симлинк вместо .opencode не получает запись за пределами выбранной папки', async () => {
        await fs.rm(path.join(fixture.root, '.opencode'), { recursive: true });
        const external = path.join(fixture.temporary, 'Внешняя папка'); await fs.mkdir(external); await fs.symlink(external, path.join(fixture.root, '.opencode'));
        await expect(prepareProjectBinding(input())).rejects.toMatchObject({ code: 'marker-invalid' });
        expect(await fs.readdir(external)).toEqual([]);
    });

    it('Появившийся после preview чужой marker не перезаписывается', async () => {
        await fs.rm(marker()); const prepared = await prepareProjectBinding(input());
        const raw = JSON.stringify({ version: 2, server: 'https://foreign.example.test', projectId, instanceId: randomUUID() });
        await fs.writeFile(marker(), raw);
        await expect(commitProjectBinding(prepared)).rejects.toMatchObject({ code: 'foreign-binding' });
        expect(await fs.readFile(marker(), 'utf8')).toBe(raw); expect(await readState('credentials')).toEqual(credentials);
    });

    it('Изменение приватной регистрации после preview аннулирует восстановление', async () => {
        await fs.rm(marker()); const prepared = await prepareProjectBinding(input());
        const registry = JSON.parse(await fs.readFile(registryFile(), 'utf8'));
        registry.instances[prepared.instanceId!].bindingNonce = randomUUID();
        const raw = JSON.stringify(registry, null, 2); await fs.writeFile(registryFile(), raw);
        await expect(commitProjectBinding(prepared)).rejects.toMatchObject({ code: 'preparation-stale' });
        expect(await fs.readFile(registryFile(), 'utf8')).toBe(raw);
        await expect(fs.stat(marker())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Ожидаемые прежние instance и binding проверяются по приватному доказательству', async () => {
        const expectedInstanceId = await projectInstanceId(projectId), expectedBindingId = await projectBindingId(projectId);
        await fs.rm(marker());
        await expect(prepareProjectBinding({ ...input(), expectedInstanceId: randomUUID() })).rejects.toMatchObject({ code: 'preparation-stale' });
        const prepared = await prepareProjectBinding({ ...input(), expectedInstanceId, expectedBindingId });
        await expect(commitProjectBinding(prepared)).resolves.toMatchObject({ instanceId: expectedInstanceId, bindingId: expectedBindingId });
    });

    it.each(['marker', 'registry'])('Ошибка записи %s откатывается, повтор восстанавливает прежнюю привязку', async target => {
        const instanceId = await projectInstanceId(projectId), bindingId = await projectBindingId(projectId);
        await fs.rm(marker()); const prepared = await prepareProjectBinding(input()), before = await fs.readFile(registryFile(), 'utf8');
        const write = atomic.atomicText; let failed = false;
        vi.spyOn(atomic, 'atomicText').mockImplementation(async (file, text, mode, encoding) => {
            if (!failed && file === (target === 'marker' ? marker() : registryFile())) { failed = true; throw Object.assign(new Error('Нет прав на запись'), { code: 'EACCES' }); }
            return write(file, text, mode, encoding);
        });
        await expect(commitProjectBinding(prepared)).rejects.toThrow('Нет прав на запись');
        expect(await fs.readFile(registryFile(), 'utf8')).toBe(before);
        await expect(fs.stat(marker())).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readdir(stateDir())).not.toContain('workspace-identity-pending.json');
        await expect(commitProjectBinding(await prepareProjectBinding(input()))).resolves.toMatchObject({ instanceId, bindingId });
        expect(await readState('credentials')).toEqual(credentials);
    });
});
