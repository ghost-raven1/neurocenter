import type { IBridgeInstallation, IBridgeJob } from './api';
import { matchingInspection } from './InstallationInspectionStatus';
import { matchingRuntime, pendingLocalJob } from './operationHelpers';
import { matchingConfigurationStatus } from './mcpConfiguration';
import {localJobStatus} from './localJobStatus';

export interface IInstallationProgress {
    state: 'installed' | 'configuration' | 'inspection' | 'runtime' | 'passed' | 'modified' | 'help' | 'pending';
    title: string; description: string; action: 'configuration' | 'inspect' | 'runtime' | 'repair' | 'none';
}
/** Одно следующее действие вместо предположения, что наличие файлов означает работающий инструмент. */
export function installationProgress(item: IBridgeInstallation, jobs: IBridgeJob[]): IInstallationProgress {
    const pending = pendingLocalJob(jobs,item);
    if (pending) { const status = localJobStatus(pending); return {state:'pending',title:status.title,description:[pending.message,status.description].filter(Boolean).join(' '),action:'none'}; }
    const inspection = matchingInspection(item);
    if (inspection?.state === 'checked' && ['modified','missing'].includes(inspection.status)) {
        return {state:'modified',title:'Есть изменения в установке',description:'Сравните файлы с одобренной версией. Перед восстановлением ручные правки будут сохранены.',action:'repair'};
    }
    if (inspection?.state === 'checked' && inspection.status === 'unknown' && inspection.issues.includes('inspection-failed')) {
        return {state:'help',title:'Сверка не завершена',description:'Сравните установку с одобренной версией. Мост подготовит план восстановления до любых изменений.',action:'repair'};
    }
    if (item.configurationSchemaDigest && !matchingConfigurationStatus(item.configuration,item)?.ready) {
        return {state:'configuration',title:'Требуется настройка',description:'Откройте мастер на выбранном компьютере, заполните параметры и проверьте готовность.',action:'configuration'};
    }
    if (!inspection || inspection.state !== 'checked' || inspection.status !== 'synced') {
        return {state:'installed',title:'Файлы установлены',description:'Следующий шаг — сверить файлы в папке проекта. Запуск пока не проверен.',action:'inspect'};
    }
    const runtime = matchingRuntime(item);
    if (runtime?.status === 'passed') { return {state:'passed',title:'Проверка пройдена',description:'Подтверждена ограниченная диагностика. Вызовы инструментов, hooks и ответы модели не проверялись.',action:'none'}; }
    if (runtime && ['failed','unsupported','needs_configuration'].includes(runtime.status)) {
        return {state:'help',title:'Нужна помощь с запуском',description:'Откройте результат диагностики ниже и устраните указанную причину. После изменений повторите проверку.',action:'runtime'};
    }
    return {state:'runtime',title:'Можно проверить запуск',description:'Файлы сверены. Для ограниченной диагностики потребуется отдельное согласие на точный одобренный комплект.',action:'runtime'};
}
