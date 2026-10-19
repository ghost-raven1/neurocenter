import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptLegacyProject, bindProject, commitProjectBinding, prepareProjectBinding, projectBindingId, projectFolder, projectInstanceId, setRoot, workspaceInstanceAt, workspaceReport } from '../src/bridge/workspace.js';
import { hash, hub, readState, stateDir, writeState, type Workspace } from '../src/bridge/state.js';
import * as atomic from '../src/bridge/atomic-file.js';
import { registryFile } from '../src/bridge/workspace-identity-state.js';
import { resolveProjectKey } from '../src/tools/resolve-project-key.js';
import { workspaceFixture } from './bridge-fixture.js';

describe('Локальная идентичность экземпляра проекта', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const projectId = 'test-project';
    const marker = (root = fixture.root) => path.join(root, '.opencode/neurocenter.json');
    const sibling = (name: string) => path.join(path.dirname(fixture.root), name);
    const prepare = (mode: 'new-copy' | 'adopt-legacy' | 'transfer', folder: string, expected?: { expectedInstanceId?: string; expectedBindingId?: string }) =>
        prepareProjectBinding({ projectId, folderName: path.basename(folder), mode, ...expected });
    const copy = async () => { const target = sibling('Копия проекта'); await fs.cp(fixture.root, target, { recursive: true }); return target; };
    const verifier = vi.fn(async () => undefined);
    beforeEach(async () => { fixture = await workspaceFixture(); verifier.mockClear(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it('Новый marker v2 подтверждён приватным реестром, повторный bind сохраняет обе идентичности', async () => {
        const instanceId = await projectInstanceId(projectId); const bindingId = await projectBindingId(projectId);
        expect(JSON.parse(await fs.readFile(marker(), 'utf8'))).toEqual({ version: 2, server: hub(), projectId, instanceId });
        await bindProject(projectId, path.basename(fixture.root));
        expect(await projectBindingId(projectId)).toBe(bindingId); expect(await projectInstanceId(projectId)).toBe(instanceId);
        expect((await fs.stat(registryFile())).mode & 0o777).toBe(0o600);
        expect((await workspaceReport()).bindings[0]).toMatchObject({ valid: true, identityStatus: 'verified', instanceId, bindingId });
    });

    it('Одного скопированного marker недостаточно даже после записи нового пути в workspace', async () => {
        const target = await copy();
        await writeState('workspace', { root: path.dirname(target), bindings: { [projectId]: target } });
        const before = await fs.readFile(marker(target), 'utf8');
        await expect(projectFolder(projectId)).rejects.toThrow('Физическая папка');
        await expect(bindProject(projectId, path.basename(target))).rejects.toThrow();
        expect((await workspaceReport()).bindings[0]).toMatchObject({ valid: false, identityStatus: 'copied' });
        expect(await fs.readFile(marker(target), 'utf8')).toBe(before);
    });

    it('Каталог-клон по тому же пути не наследует binding и не принимается как перенос оригинала', async () => {
        const instanceId = await projectInstanceId(projectId); const bindingId = await projectBindingId(projectId);
        const original = sibling('Оригинал'); await fs.rename(fixture.root, original); await fs.cp(original, fixture.root, { recursive: true });
        await expect(projectBindingId(projectId)).rejects.toThrow('Физическая папка');
        expect((await workspaceReport()).bindings[0]).toMatchObject({ valid: false, identityStatus: 'changed' });
        await expect(prepare('transfer', original, { expectedBindingId: bindingId, expectedInstanceId: instanceId })).rejects.toThrow('подменена');
    });

    it('Новая копия получает новый instance и binding, прежний каталог остаётся отдельным экземпляром', async () => {
        const instanceId = await projectInstanceId(projectId); const bindingId = await projectBindingId(projectId); const target = await copy();
        const prepared = await prepare('new-copy', target, { expectedInstanceId: instanceId, expectedBindingId: bindingId });
        const result = await commitProjectBinding(prepared, verifier);
        expect(verifier).toHaveBeenCalledWith(expect.objectContaining({ targetRoot: target, previousBindingId: bindingId }));
        expect(result.instanceId).not.toBe(instanceId); expect(result.bindingId).not.toBe(bindingId);
        expect(await projectFolder(projectId)).toBe(target); expect((await workspaceInstanceAt(fixture.root, projectId)).instanceId).toBe(instanceId);
        expect(JSON.stringify(result)).not.toContain(fixture.temporary);
    });

    it('Копия с другого компьютера без локального источника не допускает принятия неподтверждённых файлов', async () => {
        const target = await copy(); const oldInstance = await projectInstanceId(projectId);
        await fs.rm(registryFile());
        await expect(workspaceInstanceAt(target, projectId)).rejects.toThrow('не зарегистрирован');
        await expect(prepare('new-copy', target, { expectedInstanceId: oldInstance })).rejects.toThrow('зарегистрированного исходного');
        expect(verifier).not.toHaveBeenCalled();
    });

    it('Новый экземпляр в той же физической папке не принимает восстановленный старый marker', async () => {
        const raw = await fs.readFile(marker(), 'utf8'); const oldInstance = await projectInstanceId(projectId);
        const result = await commitProjectBinding(await prepare('new-copy', fixture.root), verifier);
        expect(result.instanceId).not.toBe(oldInstance);
        const current = await fs.readFile(marker(), 'utf8'); await fs.writeFile(marker(), raw);
        await expect(projectFolder(projectId)).rejects.toThrow('не зарегистрирован');
        await fs.writeFile(marker(), current); expect(await projectInstanceId(projectId)).toBe(result.instanceId);
    });

    it('No-op результат содержит только утверждённые публичные поля', async () => {
        const prepared = await prepareProjectBinding({ projectId, folderName: path.basename(fixture.root), expectedBindingId: await projectBindingId(projectId), expectedInstanceId: await projectInstanceId(projectId) });
        expect(Object.keys(await commitProjectBinding(prepared)).sort()).toEqual(['projectId', 'folderName', 'mode', 'preparation', 'instanceId', 'bindingId', 'previousBindingId'].sort());
    });

    it('Удаление marker у зарегистрированной папки не разрешает тихо создать другую identity', async () => {
        await fs.rm(marker()); const registry = await fs.readFile(registryFile(), 'utf8');
        await expect(bindProject(projectId, path.basename(fixture.root))).rejects.toThrow('потерял marker');
        expect(await fs.readFile(registryFile(), 'utf8')).toBe(registry);
        await expect(fs.stat(marker())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Свежая привязка не принимает скопированные управляемые данные с удалённым marker', async () => {
        const target = await copy(); await fs.rm(marker(target));
        await fs.mkdir(path.join(target, '.opencode/neurocenter'), { recursive: true });
        await expect(bindProject(projectId, path.basename(target))).rejects.toThrow('управляемые данные MCP без marker');
        expect(await projectFolder(projectId)).toBe(fixture.root);
        await expect(fs.stat(marker(target))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Проверенный перенос копии сохраняет instance, меняет binding и лишает старую папку действительной идентичности', async () => {
        const instanceId = await projectInstanceId(projectId); const bindingId = await projectBindingId(projectId); const target = await copy();
        const result = await commitProjectBinding(await prepare('transfer', target, { expectedInstanceId: instanceId, expectedBindingId: bindingId }), verifier);
        expect(verifier).toHaveBeenCalledWith(expect.objectContaining({ sourceRoot: fixture.root, targetRoot: target }));
        expect(result).toMatchObject({ instanceId, previousBindingId: bindingId }); expect(result.bindingId).not.toBe(bindingId);
        await expect(workspaceInstanceAt(fixture.root, projectId)).rejects.toThrow('Физическая папка');
        expect(await projectFolder(projectId)).toBe(target);
    });

    it('Переименование физического оригинала допускает перенос, если прежний путь отсутствует', async () => {
        const instanceId = await projectInstanceId(projectId); const bindingId = await projectBindingId(projectId); const target = sibling('Новое имя');
        await fs.rename(fixture.root, target);
        await expect(projectFolder(projectId)).rejects.toThrow();
        expect((await workspaceReport()).bindings[0]).toMatchObject({valid:false,identityStatus:'unavailable',previousBindingId:bindingId,instanceId});
        const result = await commitProjectBinding(await prepare('transfer', target, { expectedInstanceId: instanceId, expectedBindingId: bindingId }), verifier);
        expect(result.instanceId).toBe(instanceId); expect(result.bindingId).not.toBe(bindingId);
        expect(verifier).toHaveBeenCalledWith(expect.objectContaining({ sourceRoot: target, targetRoot: target, previousConfigRoot: fixture.root }));
    });

    it('Копия без исходного физического каталога не допускает сохранение instance через transfer', async () => {
        const instanceId = await projectInstanceId(projectId); const bindingId = await projectBindingId(projectId); const target = await copy();
        await fs.rm(fixture.root, { recursive: true });
        await expect(prepare('transfer', target, { expectedInstanceId: instanceId, expectedBindingId: bindingId })).rejects.toThrow();
    });

    it('Подмена исходной папки после preview блокирует перенос до внешней проверки и любых записей', async () => {
        const target = await copy(); const instanceId = await projectInstanceId(projectId); const bindingId = await projectBindingId(projectId);
        const prepared = await prepare('transfer', target, { expectedInstanceId: instanceId, expectedBindingId: bindingId });
        const before = await fs.readFile(marker(target), 'utf8');
        await fs.rename(fixture.root, sibling('Сохранённый оригинал')); await fs.cp(target, fixture.root, { recursive: true });
        await expect(commitProjectBinding(prepared, verifier)).rejects.toThrow('подменена');
        expect(verifier).not.toHaveBeenCalled(); expect(await fs.readFile(marker(target), 'utf8')).toBe(before);
    });

    it.each(['marker', 'workspace', 'registry', 'target'] as const)('Изменение %s во время frozen callback отменяет публикацию', async type => {
        const target = await copy(); const prepared = await prepare('new-copy', target);
        const before = await fs.readFile(marker(target), 'utf8'); const release = vi.fn(async () => undefined);
        await expect(commitProjectBinding(prepared, async () => {
            if (type === 'marker') { await fs.writeFile(marker(target), before + ' '); }
            if (type === 'workspace') { await writeState('workspace', { root: fixture.temporary, bindings: { [projectId]: fixture.root } }); }
            if (type === 'registry') { await fs.writeFile(registryFile(), await fs.readFile(registryFile(), 'utf8') + ' '); }
            if (type === 'target') { await fs.rename(target, sibling('Старый target')); await fs.cp(fixture.root, target, { recursive: true }); }
            return release;
        })).rejects.toThrow('изменились');
        expect(release).toHaveBeenCalledTimes(1);
        expect(JSON.parse(await fs.readFile(marker(target), 'utf8')).instanceId).toBe(prepared.instanceId);
    });

    it('Внешняя ошибка сверки сохраняет marker, registry и выбранную папку', async () => {
        const target = await copy(); const prepared = await prepare('new-copy', target);
        const before = await Promise.all([fs.readFile(marker(target), 'utf8'), fs.readFile(registryFile(), 'utf8'), readState('workspace')]);
        await expect(commitProjectBinding(prepared, async () => { throw new Error('Файлы отличаются от закреплённых версий.'); })).rejects.toThrow('Файлы отличаются');
        expect(await Promise.all([fs.readFile(marker(target), 'utf8'), fs.readFile(registryFile(), 'utf8'), readState('workspace')])).toEqual(before);
    });

    it('Locks внешнего verifier освобождаются после публикации новой идентичности', async () => {
        const target = await copy(); const prepared = await prepare('new-copy', target); let released = false;
        const result = await commitProjectBinding(prepared, async context => {
            await context.assertUnchanged();
            return async () => { expect(await projectFolder(projectId)).toBe(target); released = true; };
        });
        expect(released).toBe(true); expect(await projectInstanceId(projectId)).toBe(result.instanceId);
    });

    it('Legacy v1 остаётся read-only и явно показывает исторический binding без тихой миграции', async () => {
        const raw = JSON.stringify({ version: 1, server: hub(), projectId }); await fs.writeFile(marker(), raw);
        const expected = hash(JSON.stringify([hub(), projectId, fixture.root]));
        const writes = vi.spyOn(fs, 'writeFile');
        await expect(projectFolder(projectId)).rejects.toThrow('Старая привязка');
        await expect(bindProject(projectId, path.basename(fixture.root))).rejects.toThrow('Старая привязка');
        expect((await workspaceReport()).bindings[0]).toMatchObject({ valid: false, identityStatus: 'legacy', previousBindingId: expected });
        expect(JSON.parse(await resolveProjectKey({}, fixture.root))).toMatchObject({ identityVerified: false, migrationRequired: true });
        expect(writes).not.toHaveBeenCalled(); expect(await fs.readFile(marker(), 'utf8')).toBe(raw);
    });

    it('Adoption v1 требует callback и после подтверждения создаёт новую instance-идентичность', async () => {
        await fs.writeFile(marker(), JSON.stringify({ version: 1, server: hub(), projectId }));
        const prepared = await prepare('adopt-legacy', fixture.root);
        await expect(commitProjectBinding(prepared)).rejects.toThrow('проверки закреплённых файлов');
        const result = await adoptLegacyProject(projectId, path.basename(fixture.root), verifier);
        expect(result.previousBindingId).toBe(hash(JSON.stringify([hub(), projectId, fixture.root])));
        expect(await projectInstanceId(projectId)).toBe(result.instanceId);
        expect(JSON.parse(await resolveProjectKey({}, fixture.root))).toMatchObject({ identityVerified: true, instanceId: result.instanceId, bindingId: result.bindingId });
    });

    it.each(['new-copy', 'transfer'] as const)('Режим %s не допускается без внешней frozen сверки', async mode => {
        const target = await copy(); const instanceId = await projectInstanceId(projectId); const bindingId = await projectBindingId(projectId);
        const prepared = await prepare(mode, target, { expectedInstanceId: instanceId, expectedBindingId: bindingId });
        await expect(commitProjectBinding(prepared)).rejects.toThrow('проверки закреплённых файлов');
        expect(await projectFolder(projectId)).toBe(fixture.root);
    });

    it('Preview и обычное чтение не открывают сеть и не создают локальные файлы', async () => {
        const target = await copy(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
        try {
            const mutations = [vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'mkdir'), vi.spyOn(fs, 'rename'), vi.spyOn(fs, 'rm')];
            const first = await prepare('new-copy', target); const second = await prepare('new-copy', target);
            expect(first).toEqual(second); await projectFolder(projectId);
            expect(fetch).not.toHaveBeenCalled(); for (const mutation of mutations) { expect(mutation).not.toHaveBeenCalled(); }
        } finally { vi.unstubAllGlobals(); }
    });

    it('Сбой публикации registry откатывает marker, не теряет исходную привязку и освобождает lock', async () => {
        const target = await copy(); const prepared = await prepare('new-copy', target); const before = await fs.readFile(marker(target), 'utf8');
        const write = atomic.atomicText; let failed = false;
        vi.spyOn(atomic, 'atomicText').mockImplementation(async (file, text, mode, encoding) => {
            if (file === registryFile() && !failed) { failed = true; throw new Error('Диск недоступен.'); }
            return write(file, text, mode, encoding);
        });
        await expect(commitProjectBinding(prepared, verifier)).rejects.toThrow('Диск недоступен');
        expect(await fs.readFile(marker(target), 'utf8')).toBe(before); expect(await projectFolder(projectId)).toBe(fixture.root);
        expect(await fs.readdir(stateDir())).not.toContain('workspace-identity-pending.json');
        expect(await fs.readdir(stateDir())).not.toContain('workspace-identity.lock');
    });

    it('Повреждённый registry не пересоздаётся и не доверяет marker', async () => {
        await fs.writeFile(registryFile(), JSON.stringify({ version: 1, instances: [] }));
        const raw = await fs.readFile(registryFile(), 'utf8');
        await expect(projectFolder(projectId)).rejects.toThrow('реестр'); await expect(prepare('new-copy', await copy())).rejects.toThrow('реестр');
        expect(await fs.readFile(registryFile(), 'utf8')).toBe(raw);
    });

    it('Смена общей папки после preview блокирует устаревший commit', async () => {
        const target = await copy(); const prepared = await prepare('new-copy', target);
        await setRoot(fixture.temporary);
        await expect(commitProjectBinding(prepared, verifier)).rejects.toThrow(); expect(verifier).not.toHaveBeenCalled();
        expect((await readState<Workspace>('workspace'))?.bindings[projectId]).toBe(fixture.root);
    });
});
