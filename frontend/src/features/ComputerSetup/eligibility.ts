import {OPENCODE_CLI_CAPABILITY} from '@neurocenter/computer-setup';
import type {IBridgeDevice} from '../McpBridge/api';
import {roleLevel} from '../UserBlock/roles';
import {cliUuid} from './model';

interface Context {device?: IBridgeDevice; verified: boolean; assignedRole: boolean; role: string; enabled: boolean; reason: string; masterEnabled: boolean;}

/** This read-only operation has its own capability and does not inherit install/project restrictions. */
export function cliObservationBlocker({device, verified, assignedRole, role, enabled, reason, masterEnabled}: Context): string {
    if (!device || !cliUuid(device.id)) return 'Выберите подключённый компьютер.';
    if (!assignedRole || roleLevel(role) < 1) return 'Выберите действующую роль для чтения состояния компьютера.';
    if (!masterEnabled) return 'Новые проверки мастера сейчас недоступны. Сохранённое состояние доступно.';
    if (!enabled) return reason || 'Новые проверки OpenCode выключены.';
    if (!verified) return 'Статус компьютера не подтверждён. Обновите подключение.';
    if (device.requiresReconnect) return 'Подтвердите подключение компьютера заново; сохранённая проверка остаётся доступной.';
    if (roleLevel(device.role) < 1) return 'Роль подключения не разрешает чтение состояния компьютера.';
    if (!device.online) return 'Для новой проверки включите компьютер и дождитесь подключения моста.';
    if (!device.report.capabilities?.includes(OPENCODE_CLI_CAPABILITY)) return `Для проверки OpenCode обновите мост${device.report.bridgeVersion ? ` (сейчас ${device.report.bridgeVersion})` : ''}.`;
    return '';
}
