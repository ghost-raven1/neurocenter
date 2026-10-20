import type { IBridgeDevice } from './api';
import { roleLevel } from '../UserBlock/roles';

/** До первого heartbeat версия неизвестна; это ещё не признак устаревшего моста. */
export function awaitingBridgeReport(device?: IBridgeDevice): boolean {
    return !!device && !device.online && !device.lastSeen && device.report.protocolVersion === undefined && !device.report.bridgeVersion;
}

/** Общие задания не требуют поддержки установки комплектов; сервер повторяет проверки. */
export function bridgeOperationBlocker(device?: IBridgeDevice): string {
    if (!device) { return 'Выберите подключённый компьютер.'; }
    if (device.requiresReconnect) { return 'Подключение компьютера истекло. Подтвердите его заново: файлы и история установок сохранятся.'; }
    if (roleLevel(device.role) < 2) { return 'Роль этого подключения моста не разрешает изменение проекта. Переподключите компьютер с ролью разработчика или администратора.'; }
    if (awaitingBridgeReport(device)) { return 'Ожидаем первого выхода на связь. Запустите установленный мост и проверьте подключение.'; }
    const { report } = device;
    if (report.protocolVersion !== 2 || !report.capabilities?.includes('durable-completions') || !report.capabilities.includes('managed-installations')) {
        return 'Обновите мост на странице «Начало работы», чтобы выполнять задания с надёжным подтверждением результата.';
    }
    return '';
}

/** Установка и удаление требуют нового учёта зависимостей даже для одного инструмента. */
export function installationBlocker(device?: IBridgeDevice): string {
    const common = bridgeOperationBlocker(device);
    if (common) { return common; }
    if (!device?.report.capabilities?.includes('install-set-v1')) {
        return 'Обновите мост на странице «Начало работы» для безопасной установки и удаления инструментов. Установленные файлы сохранятся.';
    }
    return '';
}

/** Проверка читает файлы и доступна наблюдателю; права изменения проекта не требуются. */
export function inspectionBlocker(device?: IBridgeDevice): string {
    if (!device) { return 'Выберите подключённый компьютер.'; }
    if (device.requiresReconnect) { return 'Подключение компьютера истекло. Подтвердите его заново для проверки файлов.'; }
    if (roleLevel(device.role) < 1) { return 'Роль подключения моста не разрешает чтение проекта.'; }
    if (!device.online) { return 'Для проверки файлов включите компьютер и дождитесь подключения моста.'; }
    if (device.report.protocolVersion !== 2 || !device.report.capabilities?.includes('durable-completions')
        || !device.report.capabilities.includes('managed-installations') || !device.report.capabilities.includes('installation-inspection-v1')) {
        return 'Обновите мост на странице «Начало работы», чтобы проверять установленные файлы.';
    }
    return '';
}

/** Новые возможности проверяются отдельно и не блокируют выбор общей папки или RAG. */
export function workspaceBlocker(device?: IBridgeDevice): string {
    const common = bridgeOperationBlocker(device);
    if (common) { return common; }
    if (!device?.report.capabilities?.includes('workspace-instance-v1')) { return 'Обновите мост до версии 0.7 для безопасной привязки и переноса папок.'; }
    return device.online ? '' : 'Включите компьютер и дождитесь подключения моста для проверки папки.';
}
export function localFeatureBlocker(device: IBridgeDevice | undefined, feature: 'local-change-plan-v1' | 'runtime-probe-v1' | 'local-recovery-v1'): string {
    const common = workspaceBlocker(device);
    if (common) { return common; }
    if (!device?.report.capabilities?.includes(feature)) { return feature === 'local-recovery-v1'
        ? 'Обновите мост до версии 0.8 для сохранённых локальных вариантов.' : 'Обновите мост до версии 0.7 для восстановления файлов и диагностики запуска.'; }
    return '';
}

/** Общая причина готовности выбранного компьютера; права действий проверяются отдельно. */
export function connectionBlocker(device?: IBridgeDevice): string {
    return device ? installationBlocker(device) || workspaceBlocker(device) : '';
}

/** Убирает только повтор общего шага подключения; отдельные причины проверки остаются у неё. */
export function inspectionNotice(device: IBridgeDevice | undefined, connectionNoticeVisible = false): string {
    const blocker = inspectionBlocker(device);
    if (!connectionNoticeVisible || !blocker || !device) { return blocker; }
    if (device.requiresReconnect || roleLevel(device.role) < 1) { return ''; }
    if (!device.online) { return installationBlocker(device) ? blocker : ''; }
    const capabilities = device.report.capabilities;
    const sharedUpgrade = roleLevel(device.role) >= 2 && (device.report.protocolVersion !== 2
        || !capabilities?.includes('durable-completions') || !capabilities.includes('managed-installations')
        || !capabilities.includes('install-set-v1') || !capabilities.includes('workspace-instance-v1'));
    return sharedUpgrade ? '' : blocker;
}
