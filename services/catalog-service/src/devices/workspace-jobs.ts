import { BadRequestException, ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { Device, DeviceStore } from './device-store';
import type { DeviceInstallations } from './device-installations';
import type { IPackage } from '../catalog/bundle-package';

export const WORKSPACE_MODES = ['new', 'new-copy', 'adopt-legacy', 'transfer','resume'] as const;
type Mode = typeof WORKSPACE_MODES[number];
export interface WorkspaceJobInput {
    kind: string; projectId?: string; folderName?: string; bindingMode?: string;
    expectedBindingId?: string; expectedInstanceId?: string; preparationJobId?: string; expectedPreparation?: string;
}
interface Preparation extends Record<string, unknown> {
    projectId: string; folderName: string; mode: Mode; preparation: string; requiresFileVerification: boolean;
    expectedBindingId?: string; expectedInstanceId?: string; instanceId?: string; previousBindingId?: string; sourceFolderName?: string;
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const folder = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[/\\\x00]/.test(value) && !['.', '..'].includes(value);

export function assertWorkspaceCapability(report: Record<string, unknown>): void {
    if (!Array.isArray(report.capabilities) || !report.capabilities.includes('workspace-instance-v1')) {
        throw new ConflictException('Обновите локальный MCP до версии 0.7 для безопасной привязки, копирования и переноса папок.');
    }
}

/** Проверка не считает скопированный marker доказательством текущего экземпляра. */
export function assertWorkspaceSource(report: Record<string, unknown>, projectId: string, mode: string, expected?: string, instance?: string): void {
    assertWorkspaceCapability(report);
    if (mode === 'new' || mode === 'resume') { return; }
    const current = Array.isArray(report.bindings) ? report.bindings.find(item => item?.projectId === projectId) : undefined;
    const renamedSource = mode === 'transfer' && current?.identityStatus === 'unavailable' && current?.valid === false && sha(current?.previousBindingId);
    const actual = mode === 'adopt-legacy' || renamedSource ? current?.previousBindingId : current?.bindingId;
    if (!sha(expected) || actual !== expected || (mode !== 'adopt-legacy' && ((!renamedSource && current?.valid !== true) || !uuid(instance) || current.instanceId !== instance))) {
        throw new ConflictException('Исходная папка или экземпляр изменились. Откройте мастер привязки заново.');
    }
}

export async function workspaceJobPayload(store: DeviceStore, installations: DeviceInstallations, device: Device, input: WorkspaceJobInput): Promise<Record<string, unknown>> {
    const mode = input.bindingMode ?? 'new';
    if (!WORKSPACE_MODES.includes(mode as Mode) || !folder(input.folderName)) { throw new BadRequestException('Выберите папку и действие мастера привязки.'); }
    assertWorkspaceSource(device.report, input.projectId!, mode, input.expectedBindingId, input.expectedInstanceId);
    let preparation: Preparation | undefined;
    let preparedInstallations: unknown;
    if (input.kind === 'bind-project' && (mode !== 'new' || input.preparationJobId !== undefined || input.expectedPreparation !== undefined)) {
        if (!uuid(input.preparationJobId) || !sha(input.expectedPreparation)) { throw new ConflictException('Сначала проверьте выбранную папку в мастере.'); }
        const { rows } = await store.pool.query(`SELECT result,payload FROM bridge_jobs WHERE id=$1 AND device_id=$2
            AND project_id=$3 AND email=$4 AND kind='prepare-bind-project' AND state='succeeded'
            AND updated_at>now()-interval '15 minutes'`, [input.preparationJobId, device.id, input.projectId, device.email]);
        preparation = rows[0]?.result;
        preparedInstallations = rows[0]?.payload?.installations;
        if (!preparation || preparation.preparation !== input.expectedPreparation || preparation.mode !== mode
            || preparation.folderName !== input.folderName || preparation.expectedBindingId !== input.expectedBindingId
            || preparation.expectedInstanceId !== input.expectedInstanceId) {
            throw new ConflictException('Проверка папки устарела или относится к другому действию. Подготовьте её заново.');
        }
        assertWorkspacePreparation(preparation, { ...input, mode });
    }
    const sourceBindingId=mode === 'resume' ? preparation?.previousBindingId : input.expectedBindingId;
    let packages = mode === 'new' || mode === 'resume' && !preparation ? []
        : await installations.workspacePackages(device.email, device.id, input.projectId!, sourceBindingId);
    if (mode === 'adopt-legacy' && packages.length === 0) {
        // Явное подтверждение v1 допускает только квитанции, совпавшие с замороженной legacy-историей.
        packages = await installations.workspacePackages(device.email, device.id, input.projectId!);
    }
    if (preparation && mode !== 'resume' && !isDeepStrictEqual(preparedInstallations,packages)) {
        throw new ConflictException('Состав установок изменился после проверки папки. Откройте мастер заново.');
    }
    return { folderName: input.folderName, mode, workspaceFailureVersion: 1, ...(input.expectedBindingId ? { expectedBindingId: input.expectedBindingId } : {}),
        ...(input.expectedInstanceId ? { expectedInstanceId: input.expectedInstanceId } : {}), installations: packages,
        ...(mode === 'resume' && preparation ? {expectedBindingId:preparation.previousBindingId,expectedInstanceId:preparation.instanceId} : {}),
        ...(preparation ? { preparation } : {}) };
}

/** Публичный preview содержит имена папок и отпечатки; абсолютные пути и содержимое запрещены. */
export function assertWorkspacePreparation(value: unknown, input: { projectId?: string; folderName?: string; mode?: unknown }): asserts value is Preparation {
    const result = value as Preparation | null;
    const fields = ['projectId', 'folderName', 'mode', 'preparation', 'requiresFileVerification', 'expectedBindingId', 'expectedInstanceId', 'instanceId', 'previousBindingId', 'sourceFolderName'];
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !fields.includes(key))
        || result.projectId !== input.projectId || result.folderName !== input.folderName || result.mode !== input.mode
        || !sha(result.preparation) || typeof result.requiresFileVerification !== 'boolean'
        || (result.mode !== 'new' && result.requiresFileVerification !== true)
        || (result.mode === 'resume' && (!sha(result.previousBindingId) || !uuid(result.instanceId)))
        || ['expectedBindingId', 'previousBindingId'].some(key => result[key] !== undefined && !sha(result[key]))
        || ['expectedInstanceId', 'instanceId'].some(key => result[key] !== undefined && !uuid(result[key]))
        || (result.sourceFolderName !== undefined && !folder(result.sourceFolderName))) {
        throw new ConflictException('Результат проверки папки не соответствует исходному запросу.');
    }
}

export async function saveWorkspaceEvent(client: PoolClient, job: { id: string; device_id: string; project_id: string | null; email: string; payload: Record<string, unknown> }, result: Record<string, unknown>): Promise<void> {
    const fields = ['projectId', 'folderName', 'mode', 'preparation', 'instanceId', 'bindingId', 'previousBindingId'];
    if (Object.keys(result).some(key => !fields.includes(key)) || result.projectId !== job.project_id
        || result.folderName !== job.payload.folderName || result.mode !== job.payload.mode
        || !sha(result.preparation) || !sha(result.bindingId) || !uuid(result.instanceId)
        || (result.previousBindingId !== undefined && !sha(result.previousBindingId))
        || (job.payload.preparation && result.preparation !== (job.payload.preparation as Preparation).preparation)
        || (['transfer','resume'].includes(String(result.mode)) && result.instanceId !== job.payload.expectedInstanceId)
        || (result.mode === 'new-copy' && result.instanceId === job.payload.expectedInstanceId)
        || (result.mode !== 'new' && result.previousBindingId !== job.payload.expectedBindingId)) {
        throw new ConflictException('Результат привязки не подтверждает проверенный экземпляр проекта.');
    }
    await client.query(`INSERT INTO bridge_instance_events(id,device_id,project_id,email,event,instance_id,binding_id,previous_binding_id,installations)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [job.id, job.device_id, job.project_id, job.email, result.mode,
        result.instanceId, result.bindingId, result.previousBindingId ?? null, JSON.stringify(job.payload.installations as IPackage[] ?? [])]);
}
