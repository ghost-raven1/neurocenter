import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, hub, readState, stateDir, type Workspace } from './state.js';
import { safeTarget, workspaceDirectory as directory } from './workspace-paths.js';
import { commitWorkspaceIdentity, optionalText, readInstanceRegistry, recoverWorkspaceIdentity, registryFile, saveWorkspaceBindingCompletion, UUID, withWorkspaceIdentityLock } from './workspace-identity-state.js';
import { WorkspaceIdentityError, type PhysicalDirectory, type VerifyWorkspaceFiles, type WorkspaceBindingInput, type WorkspaceBindingPreparation, type WorkspaceBindingResult, type WorkspaceInstance, type WorkspaceMarker } from './workspace-instance.model.js';

export type { VerifyWorkspaceFiles, WorkspaceBindingInput, WorkspaceBindingMode, WorkspaceBindingPreparation, WorkspaceBindingResult, WorkspaceFileVerification } from './workspace-instance.model.js';
const markerRelative = '.opencode/neurocenter.json';
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const legacyBindingId = (projectId: string, folder: string) => hash(JSON.stringify([hub(), projectId, folder]));
const bindingId = (instance: WorkspaceInstance) => hash(JSON.stringify([hub(), instance.projectId, instance.instanceId, instance.bindingNonce]));
const samePhysical = (first: PhysicalDirectory, second: PhysicalDirectory) => JSON.stringify(first) === JSON.stringify(second);

async function markerAt(folder: string): Promise<{ marker?: WorkspaceMarker; raw: string | null; file: string }> {
    try {
        const file = await safeTarget(folder, markerRelative);
        const raw = await optionalText(file, 64 * 1024);
        if (raw === null) { return { raw, file }; }
        const marker = JSON.parse(raw) as WorkspaceMarker;
        if (!marker || typeof marker !== 'object' || Array.isArray(marker) || ![1, 2].includes(marker.version)
            || typeof marker.server !== 'string' || typeof marker.projectId !== 'string' || !marker.projectId
            || marker.version === 2 && (typeof marker.instanceId !== 'string' || !UUID.test(marker.instanceId))) { throw new Error(); }
        return { marker, raw, file };
    } catch { throw new WorkspaceIdentityError('unavailable', 'Привязка локального проекта повреждена или недоступна.'); }
}

async function assertNoPendingIdentity(): Promise<void> {
    try {
        await fs.lstat(path.join(stateDir(), 'workspace-identity-pending.json'));
        throw new WorkspaceIdentityError('unavailable', 'Незавершённая привязка требует восстановления перед использованием папки.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
}

/** Проверяет marker и приватную регистрацию физического каталога без каких-либо записей. */
export async function workspaceInstanceAt(folder: string, projectId: string): Promise<WorkspaceInstance> {
    await assertNoPendingIdentity();
    const target = await directory(folder);
    const observedMarker = await markerAt(target.realpath);
    const { marker } = observedMarker;
    if (!marker || marker.server !== hub() || marker.projectId !== projectId) { throw new WorkspaceIdentityError('changed', 'Привязка локального проекта изменилась.'); }
    if (marker.version === 1) { throw new WorkspaceIdentityError('legacy', 'Старая привязка требует явного подтверждения и проверки файлов.'); }
    const registry = await readInstanceRegistry();
    const instance = registry.instances[marker.instanceId!];
    if (!instance || instance.projectId !== projectId) { throw new WorkspaceIdentityError('copied', 'Экземпляр папки не зарегистрирован на этом компьютере. Выберите новую копию или проверенный перенос.'); }
    if (instance.realpath !== target.realpath || !samePhysical(instance.physical, target.physical)) {
        throw new WorkspaceIdentityError(instance.realpath === target.realpath ? 'changed' : 'copied', 'Физическая папка отличается от зарегистрированного экземпляра. Требуется явная привязка.');
    }
    if (JSON.stringify(await directory(folder)) !== JSON.stringify(target)
        || (await markerAt(target.realpath)).raw !== observedMarker.raw
        || JSON.stringify((await readInstanceRegistry()).instances[instance.instanceId]) !== JSON.stringify(instance)) {
        throw new WorkspaceIdentityError('changed', 'Привязка локального проекта изменилась во время проверки.');
    }
    await assertNoPendingIdentity();
    return instance;
}

async function selectedFolder(projectId: string): Promise<string> {
    const workspace = await readState<Workspace>('workspace');
    const folder = workspace?.bindings && Object.hasOwn(workspace.bindings, projectId) ? workspace.bindings[projectId] : undefined;
    if (typeof folder !== 'string' || !folder) { throw new Error('Свяжите локальную папку с этим проектом на странице «Проекты».'); }
    return folder;
}
async function selectedInstance(projectId: string): Promise<WorkspaceInstance> {
    const folder = await selectedFolder(projectId); const instance = await workspaceInstanceAt(folder, projectId);
    if (await selectedFolder(projectId) !== folder) { throw new WorkspaceIdentityError('changed', 'Выбранная папка проекта изменилась во время проверки.'); }
    return instance;
}
export async function projectFolder(projectId: string): Promise<string> { return (await selectedInstance(projectId)).realpath; }
export async function projectBindingId(projectId: string): Promise<string> { return bindingId(await selectedInstance(projectId)); }
export async function projectInstanceId(projectId: string): Promise<string> { return (await selectedInstance(projectId)).instanceId; }

/** Недействительная привязка остаётся видимой; старый path-hash служит только историческим происхождением. */
export async function workspaceBindingReport(projectId: string, folder: string) {
    try {
        const instance = await workspaceInstanceAt(folder, projectId);
        return { projectId, folderName: path.basename(folder), valid: true, bindingId: bindingId(instance), instanceId: instance.instanceId, identityStatus: 'verified' as const };
    } catch (error) {
        const identityStatus = error instanceof WorkspaceIdentityError ? error.identityStatus : 'unavailable';
        let missingSource: WorkspaceInstance | undefined;
        if (identityStatus === 'unavailable') {
            try { await fs.lstat(folder); }
            catch (reason) {
                if ((reason as NodeJS.ErrnoException).code === 'ENOENT') {
                    const registry = await readInstanceRegistry();
                    missingSource = Object.values(registry.instances).find(instance => instance.projectId === projectId && instance.realpath === folder);
                }
            }
        }
        return { projectId, folderName: path.basename(folder), valid: false, identityStatus,
            ...(identityStatus === 'legacy' ? { previousBindingId: legacyBindingId(projectId, folder) } : {}),
            ...(missingSource ? {previousBindingId:bindingId(missingSource),instanceId:missingSource.instanceId} : {}),
            error: error instanceof Error ? error.message : 'Папка проекта недоступна.' };
    }
}

function validateInput(input: WorkspaceBindingInput): void {
    if (!input || typeof input.projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(input.projectId)
        || typeof input.folderName !== 'string' || !input.folderName || input.folderName.includes('/') || input.folderName.includes('\\')
        || input.folderName.includes(':') || /[\x00-\x1f]/.test(input.folderName) || ['.', '..'].includes(input.folderName)
        || input.mode !== undefined && !['new', 'new-copy', 'adopt-legacy', 'transfer', 'resume'].includes(input.mode)
        || input.expectedBindingId !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedBindingId)
        || input.expectedInstanceId !== undefined && !UUID.test(input.expectedInstanceId)) { throw new Error('Выберите допустимую локальную папку и режим привязки.'); }
}

async function snapshot(input: WorkspaceBindingInput) {
    validateInput(input);
    await assertNoPendingIdentity();
    const workspace = await readState<Workspace>('workspace');
    if (!workspace?.root) { throw new Error('Сначала выберите общую папку проектов.'); }
    const root = await directory(workspace.root);
    const target = await directory(await safeTarget(root.realpath, input.folderName));
    const marker = await markerAt(target.realpath);
    const registry = await readInstanceRegistry();
    const mode = input.mode ?? 'new';
    if (marker.marker && (marker.marker.server !== hub() || marker.marker.projectId !== input.projectId)) { throw new Error('Эта папка уже связана с другим проектом или сервером.'); }
    let previousBindingId: string | undefined;
    let source: Awaited<ReturnType<typeof directory>> | undefined;
    let sourceMarker: Awaited<ReturnType<typeof markerAt>> | undefined;
    let instance = marker.marker?.instanceId ? registry.instances[marker.marker.instanceId] : undefined;
    if (mode === 'new') {
        if (marker.marker) {
            instance = await workspaceInstanceAt(target.realpath, input.projectId);
            if (workspace.bindings[input.projectId] !== target.realpath) { throw new Error('Повторная привязка требует явного возврата к ранее подключённой папке, новой копии или переноса.'); }
            previousBindingId = bindingId(instance);
        } else {
            if (Object.values(registry.instances).some(previous => previous.realpath === target.realpath || samePhysical(previous.physical, target.physical))) {
                throw new Error('Зарегистрированный экземпляр потерял marker. Восстановите привязку перед изменением идентичности.');
            }
            try {
                await fs.lstat(await safeTarget(target.realpath, '.opencode/neurocenter'));
                throw new Error('В папке уже есть управляемые данные MCP без marker. Требуется восстановление исходной привязки и проверка файлов.');
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        }
    } else if (mode === 'adopt-legacy') {
        if (marker.marker?.version !== 1) { throw new Error('Подтверждение старой привязки доступно только для marker v1.'); }
        previousBindingId = legacyBindingId(input.projectId, target.realpath);
    } else if (mode === 'new-copy') {
        if (marker.marker?.version !== 2 || !instance || instance.projectId !== input.projectId) {
            throw new Error('Копия требует зарегистрированного исходного экземпляра на этом компьютере и закреплённых версий инструментов.');
        }
        previousBindingId = bindingId(instance);
    } else if (mode === 'resume') {
        if (marker.marker?.version !== 2 || !instance || instance.projectId !== input.projectId) {
            throw new Error('Вернуться можно только к ранее зарегистрированному экземпляру этой папки.');
        }
        // Копия marker не доказывает прежний каталог: сверяем путь, dev, inode и birthtime.
        instance = await workspaceInstanceAt(target.realpath, input.projectId);
        previousBindingId = bindingId(instance); source = target; sourceMarker = marker;
    } else {
        if (marker.marker?.version !== 2 || !instance || instance.projectId !== input.projectId
            || !input.expectedBindingId || !input.expectedInstanceId) { throw new Error('Перенос требует зарегистрированного исходного экземпляра и его подтверждённой привязки.'); }
        previousBindingId = bindingId(instance);
    }
    if (mode === 'new-copy' || mode === 'transfer') {
        try {
            source = await directory(instance!.realpath);
            sourceMarker = await markerAt(source.realpath);
            if (!samePhysical(source.physical, instance!.physical) || sourceMarker.marker?.instanceId !== instance!.instanceId
                || sourceMarker.marker.server !== hub() || sourceMarker.marker.projectId !== input.projectId) { throw new Error('Исходная папка переноса была подменена.'); }
        } catch (error) {
            // Переименование сохраняет dev+ino; занятый другим каталогом старый путь не считается переносом.
            if (mode !== 'transfer' || (error as NodeJS.ErrnoException).code !== 'ENOENT' || !samePhysical(target.physical, instance!.physical)) { throw error; }
            source = target; sourceMarker = marker;
        }
    }
    if (input.expectedBindingId !== undefined && input.expectedBindingId !== previousBindingId) { throw new Error('Исходная привязка изменилась. Подготовьте действие заново.'); }
    if (input.expectedInstanceId !== undefined && input.expectedInstanceId !== marker.marker?.instanceId) { throw new Error('Экземпляр папки изменился. Подготовьте действие заново.'); }
    const workspaceRaw = await optionalText(path.join(stateDir(), 'workspace.json'));
    const registryRaw = await optionalText(registryFile());
    const state = { input: { projectId: input.projectId, folderName: input.folderName, mode,
        ...(input.expectedBindingId ? { expectedBindingId: input.expectedBindingId } : {}), ...(input.expectedInstanceId ? { expectedInstanceId: input.expectedInstanceId } : {}) },
        root, target, marker, source, sourceMarker, workspaceRaw, registryRaw, previousBindingId };
    const preparation: WorkspaceBindingPreparation = { ...state.input, preparation: hash(JSON.stringify(state)), requiresFileVerification: mode !== 'new',
        ...(marker.marker?.instanceId ? { instanceId: marker.marker.instanceId } : {}), ...(previousBindingId ? { previousBindingId } : {}),
        ...(source ? { sourceFolderName: path.basename(source.realpath) } : {}) };
    return { ...state, preparation, workspace, registry, instance };
}

/** Подготовка является чтением: её SHA закрепляет оба физических каталога, marker и приватное состояние. */
export async function prepareProjectBinding(input: WorkspaceBindingInput): Promise<WorkspaceBindingPreparation> { return (await snapshot(input)).preparation; }

/** Изменение идентичности возможно только после явного preview и внешней проверки закреплённых файлов. */
export async function commitProjectBinding(prepared: WorkspaceBindingPreparation, verifyFrozenFiles?: VerifyWorkspaceFiles): Promise<WorkspaceBindingResult> {
    if (!prepared || !/^[a-f0-9]{64}$/.test(prepared.preparation)) { throw new Error('Сначала подготовьте привязку папки.'); }
    return withWorkspaceIdentityLock(async () => {
        const recovered = await recoverWorkspaceIdentity(true);
        if (recovered?.preparation === prepared.preparation) { return recovered; }
        const current = await snapshot(prepared);
        const assertUnchanged = async () => {
            try {
                if ((await snapshot(prepared)).preparation.preparation === prepared.preparation) { return; }
            } catch { /* Исчезновение или подмена каталога также аннулирует подготовленное действие. */ }
            throw new Error('Папки или привязка изменились после подготовки. Подготовьте действие заново.');
        };
        await assertUnchanged();
        let release: void | (() => Promise<void>) = undefined;
        try {
            if (current.preparation.requiresFileVerification) {
                if (!verifyFrozenFiles) { throw new Error('Миграция требует проверки закреплённых файлов исходной и целевой папки.'); }
                release = await verifyFrozenFiles({ projectId: prepared.projectId, mode: current.input.mode, targetRoot: current.target.realpath,
                    ...(current.source ? { sourceRoot: current.source.realpath } : {}), ...(current.previousBindingId ? { previousBindingId: current.previousBindingId } : {}),
                    ...(current.instance ? { previousConfigRoot: current.instance.realpath } : {}),
                    ...(current.marker.marker?.instanceId ? { instanceId: current.marker.marker.instanceId } : {}), assertUnchanged });
                await assertUnchanged();
            }
            if (current.input.mode === 'new' && current.instance) {
                const result: WorkspaceBindingResult = { projectId: prepared.projectId, folderName: prepared.folderName, mode: 'new', preparation: prepared.preparation,
                    instanceId: current.instance.instanceId, bindingId: bindingId(current.instance), previousBindingId: bindingId(current.instance) };
                await saveWorkspaceBindingCompletion(result);
                return result;
            }
            const instance: WorkspaceInstance = { instanceId: ['transfer', 'resume'].includes(current.input.mode) ? current.instance!.instanceId : randomUUID(),
                projectId: prepared.projectId, server: hub(), realpath: current.target.realpath, physical: current.target.physical, bindingNonce: randomUUID() };
            // Старая запись той же физической папки не должна ожить при восстановлении marker из копии.
            for (const [key, previous] of Object.entries(current.registry.instances)) {
                if (key !== instance.instanceId && (previous.realpath === instance.realpath || samePhysical(previous.physical, instance.physical))) {
                    delete current.registry.instances[key];
                }
            }
            current.registry.instances[instance.instanceId] = instance;
            if (Object.keys(current.registry.instances).length > 1000) { throw new Error('Превышен лимит 1000 локальных экземпляров.'); }
            current.workspace.bindings[prepared.projectId] = instance.realpath;
            if (Buffer.byteLength(json(current.registry)) > 1048576 || Buffer.byteLength(json(current.workspace)) > 1048576) {
                throw new Error('Приватная настройка превышает лимит 1 МиБ. Привязка не изменена.');
            }
            await fs.mkdir(path.dirname(current.marker.file), { recursive: true });
            await assertUnchanged();
            const result: WorkspaceBindingResult = { projectId: prepared.projectId, folderName: prepared.folderName, mode: current.input.mode, preparation: prepared.preparation,
                instanceId: instance.instanceId, bindingId: bindingId(instance), ...(current.previousBindingId ? { previousBindingId: current.previousBindingId } : {}) };
            await commitWorkspaceIdentity([
                { file: current.marker.file, before: current.marker.raw, after: json({ version: 2, server: hub(), projectId: prepared.projectId, instanceId: instance.instanceId }) },
                { file: registryFile(), before: current.registryRaw, after: json(current.registry) },
                { file: path.join(stateDir(), 'workspace.json'), before: current.workspaceRaw, after: json(current.workspace) },
            ], current.target, result);
            return result;
        } finally { if (release) { await release(); } }
    });
}

/** Старый API создаёт только новый экземпляр; legacy и копии требуют явного подготовленного действия. */
export async function bindProject(projectId: string, folderName: string): Promise<void> {
    await commitProjectBinding(await prepareProjectBinding({ projectId, folderName }));
}

/** Удобный явный путь миграции v1; внешняя сверка обязательна и не заменяется чтением marker. */
export async function adoptLegacyProject(projectId: string, folderName: string, verifyFrozenFiles: VerifyWorkspaceFiles): Promise<WorkspaceBindingResult> {
    return commitProjectBinding(await prepareProjectBinding({ projectId, folderName, mode: 'adopt-legacy' }), verifyFrozenFiles);
}
