import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitProjectBinding, prepareProjectBinding, projectFolder } from '../src/bridge/workspace.js';
import { stateDir } from '../src/bridge/state.js';
import { registryFile } from '../src/bridge/workspace-identity-state.js';
import { verifyWorkspaceInstallations } from '../src/bridge/workspace-installations.js';
import { WorkspaceBindingError, workspaceBindingFailure, workspaceBindingFailureResult } from '../src/bridge/workspace-binding-error.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

describe('Безопасные причины отказа привязки папки', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const projectId = 'test-project';
    const marker = (root = fixture.root) => path.join(root, '.opencode/neurocenter.json');
    const input = () => ({ projectId, folderName: path.basename(fixture.root) });
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it.each(['server', 'projectId'])('Чужой %s сохраняет marker и передаёт только foreign-binding', async field => {
        const value = JSON.parse(await fs.readFile(marker(), 'utf8'));
        value[field] = field === 'server' ? 'https://another.example.test' : 'another-project';
        const raw = JSON.stringify(value); await fs.writeFile(marker(), raw);
        const error = await prepareProjectBinding(input()).catch(reason => reason);
        expect(workspaceBindingFailureResult('prepare-bind-project', 1, error)).toEqual({ workspaceFailure: 'foreign-binding' });
        expect(await fs.readFile(marker(), 'utf8')).toBe(raw);
    });

    it('Удалённый marker зарегистрированной папки требует восстановления', async () => {
        await fs.rm(marker());
        const error = await prepareProjectBinding(input()).catch(reason => reason);
        expect(workspaceBindingFailure(error)).toBe('marker-missing');
        await expect(fs.stat(marker())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('Повреждённый marker не превращается в новую привязку', async () => {
        await fs.writeFile(marker(), '{bad json');
        expect(workspaceBindingFailure(await prepareProjectBinding(input()).catch(reason => reason))).toBe('marker-invalid');
        expect(await fs.readFile(marker(), 'utf8')).toBe('{bad json');
    });

    it('Незавершённый журнал даёт recovery-required до изменения marker', async () => {
        const raw = await fs.readFile(marker(), 'utf8');
        await fs.writeFile(path.join(stateDir(), 'workspace-identity-pending.json'), '{}');
        expect(workspaceBindingFailure(await prepareProjectBinding(input()).catch(reason => reason))).toBe('recovery-required');
        expect(await fs.readFile(marker(), 'utf8')).toBe(raw);
    });

    it('Ранее подключённая папка предлагает явный возврат', async () => {
        const copy = path.join(path.dirname(fixture.root), 'копия'); await fs.cp(fixture.root, copy, { recursive: true });
        await commitProjectBinding(await prepareProjectBinding({ projectId, folderName: path.basename(copy), mode: 'new-copy' }), context => verifyWorkspaceInstallations(context, []));
        expect(workspaceBindingFailure(await prepareProjectBinding(input()).catch(reason => reason))).toBe('resume-required');
        expect(await projectFolder(projectId)).toBe(copy);
    });

    it('Изменение workspace после проверки аннулирует подготовку без записи marker', async () => {
        const target = path.join(path.dirname(fixture.root), 'новая папка'); await fs.mkdir(target);
        const prepared = await prepareProjectBinding({ projectId, folderName: path.basename(target) });
        await fs.appendFile(path.join(stateDir(), 'workspace.json'), ' ');
        expect(workspaceBindingFailure(await commitProjectBinding(prepared).catch(reason => reason))).toBe('preparation-stale');
        await expect(fs.stat(marker(target))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await projectFolder(projectId)).toBe(fixture.root);
    });

    it('Копия без локального исходного экземпляра даёт source-unavailable', async () => {
        const target = path.join(path.dirname(fixture.root), 'копия'); await fs.cp(fixture.root, target, { recursive: true });
        await fs.rm(registryFile());
        expect(workspaceBindingFailure(await prepareProjectBinding({ projectId, folderName: path.basename(target), mode: 'new-copy' }).catch(reason => reason))).toBe('source-unavailable');
    });

    it('Отсутствующая квитанция не маскируется общей ошибкой папки', async () => {
        const prepared = await prepareProjectBinding({ ...input(), mode: 'resume' });
        const error = await commitProjectBinding(prepared, context => verifyWorkspaceInstallations(context, [packageFixture()])).catch(reason => reason);
        expect(workspaceBindingFailure(error)).toBe('installation-mismatch');
        expect(await projectFolder(projectId)).toBe(fixture.root);
    });

    it.each([undefined, 0, 2, '1'])('Сервер без согласованной версии %s получает прежний пустой результат', version => {
        expect(workspaceBindingFailureResult('bind-project', version, new WorkspaceBindingError('foreign-binding', 'Приватное сообщение'))).toEqual({});
    });

    it('Неизвестная ошибка с секретом или путём никогда не попадает в результат', () => {
        const error = Object.assign(new Error('/private/user/project: token=secret'), { code: 'invalid-public-code' });
        expect(workspaceBindingFailureResult('bind-project', 1, error)).toEqual({ workspaceFailure: 'unknown' });
        expect(workspaceBindingFailureResult('install', 1, error)).toEqual({});
    });

    it.each([['EACCES', 'permission-denied'], ['EPERM', 'permission-denied'], ['ENOENT', 'folder-unavailable'], ['ENOTDIR', 'folder-unavailable']] as const)('Системный %s передаётся безопасным кодом %s', (code, expected) => {
        expect(workspaceBindingFailure(Object.assign(new Error('/private/path'), { code }))).toBe(expected);
    });
});
