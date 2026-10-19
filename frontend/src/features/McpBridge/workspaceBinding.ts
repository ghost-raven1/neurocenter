import type { IBridgeDevice, IBridgeJobDraft } from './api';
import type { IBridgeBinding, IWorkspacePreparation, TWorkspaceBindingMode } from './operationTypes';
import { sha, uuid } from './operationHelpers';

export const workspaceModeLabels: Record<TWorkspaceBindingMode, string> = {
    new: 'Связать новую папку', 'new-copy': 'Создать отдельную копию', 'adopt-legacy': 'Подтвердить старую привязку', transfer: 'Перенести существующий экземпляр',
    resume: 'Ранее подключённая папка',
};
export const workspaceModeDescriptions: Record<TWorkspaceBindingMode, string> = {
    new: 'Для папки, которую ещё не связывали через мост. Уже подтверждённая текущая папка сохранит свою идентичность.',
    'new-copy': 'Копия получит отдельный экземпляр. Исходная папка должна оставаться доступной на этом компьютере; файлы сравнятся с сохранёнными версиями.',
    'adopt-legacy': 'Мост сверит файлы старой установки и создаст подтверждённый экземпляр. Старая история сохранится.',
    transfer: 'Мост проверит оригинальный каталог и сохранит экземпляр в новой папке. Привязка изменится; прежняя папка перестанет быть текущей.',
    resume: 'Вернуться к ранее подключённой папке на этом компьютере. Мост проверит её экземпляр и файлы, сохранит идентичность и создаст актуальную привязку.',
};
export function workspaceSource(binding: IBridgeBinding | undefined, mode: TWorkspaceBindingMode): {expectedBindingId?: string; expectedInstanceId?: string} {
    if (mode === 'new' || mode === 'resume') { return {}; }
    if (mode === 'adopt-legacy') {
        if (binding?.identityStatus !== 'legacy' || !sha(binding.previousBindingId)) { throw new Error('Старая привязка не найдена. Обновите данные компьютера.'); }
        return { expectedBindingId: binding.previousBindingId };
    }
    const unavailableTransfer = mode === 'transfer' && binding?.identityStatus === 'unavailable' && sha(binding.previousBindingId);
    const bindingId = binding?.valid === true ? binding.bindingId : unavailableTransfer ? binding?.previousBindingId : undefined;
    if (!sha(bindingId) || !uuid(binding?.instanceId)) { throw new Error('Для этого действия нужен подтверждённый исходный экземпляр на выбранном компьютере.'); }
    return { expectedBindingId: bindingId, expectedInstanceId: binding!.instanceId };
}
export const workspaceSnapshot = (device: IBridgeDevice | undefined, projectId: string): string => JSON.stringify([
    device?.id, device?.role, device?.requiresReconnect, device?.report.root,
    device?.report.bindings?.find(binding => binding.projectId === projectId),
]);
export function matchingWorkspacePreparation(value: unknown, input: Extract<IBridgeJobDraft, {kind:'prepare-bind-project'|'bind-project'}>): IWorkspacePreparation | undefined {
    const result = value as IWorkspacePreparation | undefined;
    if (!result || result.projectId !== input.projectId || result.folderName !== input.folderName || result.mode !== input.bindingMode || !sha(result.preparation)
        || result.expectedBindingId !== input.expectedBindingId || result.expectedInstanceId !== input.expectedInstanceId
        || typeof result.requiresFileVerification !== 'boolean' || result.mode !== 'new' && !result.requiresFileVerification
        || result.instanceId !== undefined && !uuid(result.instanceId) || result.previousBindingId !== undefined && !sha(result.previousBindingId)
        || result.sourceFolderName !== undefined && (typeof result.sourceFolderName !== 'string' || /[\\/\x00]/.test(result.sourceFolderName))) { return undefined; }
    return result;
}
