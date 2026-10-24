import { BadRequestException } from '@nestjs/common';
import { roleObject, roleRequestId, roleSelection, startRoleRun } from '../system-roles/system-role.validation';
import { systemRole } from '../system-roles/system-role.definitions';

export function chatObject(value: unknown, keys: string[]): Record<string, unknown> {
    if (!roleObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw new BadRequestException('Проверьте поля сервисного диалога.');
    return value;
}
export function chatProject(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new BadRequestException('Выберите точный ID проекта.');
    return value;
}
export function createSystemDialog(value: unknown) {
    const input = chatObject(value, ['id', 'title', 'projectId']);
    if (typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 240 || input.title.includes('\0')) throw new BadRequestException('Назовите диалог: до 240 байт.');
    return { id: roleRequestId(input.id), title: input.title.trim(), projectId: chatProject(input.projectId) };
}
export function prepareSystemTurn(value: unknown) {
    const input = chatObject(value, ['agentId', 'selection', 'includeContext']);
    if (input.includeContext !== undefined && typeof input.includeContext !== 'boolean') throw new BadRequestException('Подтвердите выбор контекста.');
    const agentId = systemRole(String(input.agentId)).id;
    return { agentId, selection: roleSelection(agentId, input.selection), includeContext: input.includeContext === true };
}
/** Source and turn identity are server-owned; caller input cannot impersonate an accepted intent. */
export function sendSystemTurn(dialogId: string, value: unknown) {
    const raw = chatObject(value, ['agentId', 'input']), agentId = systemRole(String(raw.agentId)).id;
    const input = chatObject(raw.input, ['projectId', 'instruction', 'diagnostics', 'targets', 'mcp', 'requestId', 'modelId', 'expectedModelPin', 'expectedDefinitionPin', 'consentDigest']);
    const requestId = roleRequestId(input.requestId);
    return { agentId, input: startRoleRun(agentId, { ...input, sourceFeature: 'system_role_chat', source: { kind: 'system-role-chat', dialogId, turnId: requestId } }) };
}
