import type {ICatalogModel} from '../ModelCatalog/types';
import {catalogInferenceModelReady} from '../ModelCatalog/availability';
import type {IBridgeJob} from '../McpBridge/api';
import type {useBridge} from '../McpBridge/useBridge';
import {bridgeOperationBlocker} from '../McpBridge/readiness';
import type {IProviderSetupJob, IProviderSetupRequest, IProviderSetupSelection, IProviderSetupTarget, OpenCodeProviderIdentity, OpenCodeProviderKind, OpenCodeProviderStatus, TProviderReport} from './types';

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const states = ['queued', 'running', 'reconciling', 'succeeded', 'failed', 'cancelled'];
export const providerJobPending = (job: IProviderSetupJob | undefined): boolean => !!job && ['queued', 'running', 'reconciling'].includes(job.state);
/** A local adapter follows the catalog runtime; a compatible API never substitutes another runtime. */
export const providerKindForModel = (model: ICatalogModel): Exclude<OpenCodeProviderKind, 'codex-bridge'> | undefined =>
    model.runtime === 'remote-openai' ? 'openai-compatible' : model.runtime === 'remote-ollama' ? 'ollama' : undefined;
/** Native scanner/compiler currently accept ASCII selectors up to128; server API IDs may be longer. */
export const providerModelCompatibilityReason = (model: ICatalogModel): string => !!providerKindForModel(model) && model.capability !== 'embedding'
    && (model.model.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model.model) || model.model.includes('://'))
    ? 'Для OpenCode нужен идентификатор модели до 128 символов: латинские буквы, цифры и . _ : / -. Эта модель остаётся доступна через серверное API.' : '';
export const providerModelEligible = (model: ICatalogModel): boolean => !!providerKindForModel(model) && catalogInferenceModelReady(model) && !providerModelCompatibilityReason(model);

/** A named computer and exact physical project instance are required even for a status request. */
export function providerSetupTarget(bridge: ReturnType<typeof useBridge>, projectId: string | undefined, kind: OpenCodeProviderKind = 'openai-compatible'): {target?: IProviderSetupTarget; reason: string} {
    if (!projectId || !/^prj-[a-zA-Z0-9-]{1,235}$/.test(projectId)) return {reason: 'Выберите проект, затем компьютер для настройки OpenCode.'};
    if (!bridge.devicesReady || !bridge.jobsReady) return {reason: bridge.errors.devices || bridge.errors.jobs || 'Дождитесь проверки компьютера и очереди.'};
    const reason = bridgeOperationBlocker(bridge.device); if (reason) return {reason};
    if (!bridge.device?.name.trim() || !uuid(bridge.device.id)) return {reason: 'Выберите компьютер с подтверждённым именем.'};
    if (!bridge.device.report.capabilities?.includes('opencode-providers-v1')) return {reason: 'Обновите мост для локальной настройки провайдеров OpenCode.'};
    if (kind === 'ollama' && !bridge.device.report.capabilities.includes('opencode-ollama-v1')) return {reason: 'Обновите мост для настройки Ollama в OpenCode.'};
    const binding = bridge.device.report.bindings?.find(item => item.projectId === projectId && item.valid !== false);
    if (!binding || !sha(binding.bindingId) || !uuid(binding.instanceId)) return {reason: 'Свяжите и подтвердите папку проекта на выбранном компьютере.'};
    return {target: {deviceId: bridge.device.id, projectId, expectedBindingId: binding.bindingId, expectedInstanceId: binding.instanceId}, reason: ''};
}

/** Validate the queued ACK before discarding an uncertain request key; a different model is never accepted. */
export function providerJob(value: unknown, input: IProviderSetupSelection & {kind: string; expectedProviderSchemaDigest?: string}, identity?: OpenCodeProviderIdentity): IProviderSetupJob | undefined {
    if (!record(value) || !uuid(value.id) || value.kind !== input.kind || value.deviceId !== input.deviceId || value.projectId !== input.projectId
        || value.bindingId !== input.expectedBindingId || value.expectedInstanceId !== input.expectedInstanceId || (typeof value.state !== 'string' || !states.includes(value.state))
        || value.providerKind !== input.providerKind || value.catalogModelId !== (input.catalogModelId ?? null) || value.expectedModelPin !== (input.expectedModelPin ?? null)
        || typeof value.providerId !== 'string' || !(input.providerKind === 'codex-bridge' ? /^neurocenter-codex-[a-f0-9]{16}$/ : input.providerKind === 'ollama' ? /^neurocenter-ollama-[a-f0-9]{16}$/ : /^neurocenter-openai-[a-f0-9]{16}$/).test(value.providerId)
        || !sha(value.providerSchemaDigest) || input.expectedProviderSchemaDigest && value.providerSchemaDigest !== input.expectedProviderSchemaDigest
        || identity && (value.providerId !== identity.providerId || value.providerSchemaDigest !== identity.schemaDigest)
        || typeof value.message !== 'string' || value.message.length > 4096 || !iso(value.createdAt) || !iso(value.updatedAt)) return undefined;
    return value as unknown as IProviderSetupJob;
}

const identityKeys = ['schemaVersion', 'deviceId', 'projectId', 'bindingId', 'instanceId', 'providerKind', 'providerId', 'schemaDigest', 'connector', 'catalogModelId', 'modelPin'];
/** Browser projection mirrors the shared public report, never its private device descriptor or endpoint. */
export function providerReport(job: IProviderSetupJob, input: IProviderSetupRequest, preparationId?: string): TProviderReport | undefined {
    const value = job.result;
    if (!record(value) || value.schemaVersion !== 1 || value.deviceId !== input.deviceId || value.projectId !== input.projectId
        || value.bindingId !== input.expectedBindingId || value.instanceId !== input.expectedInstanceId || value.providerKind !== input.providerKind
        || value.providerId !== job.providerId || value.schemaDigest !== job.providerSchemaDigest
        || value.catalogModelId !== (input.catalogModelId ?? null) || value.modelPin !== (input.expectedModelPin ?? null)) return undefined;
    if (input.providerKind !== 'codex-bridge' ? value.connector !== null : !record(value.connector) || Object.keys(value.connector).sort().join(',') !== 'assetId,manifest,sourceCommit,version'
        || typeof value.connector.assetId !== 'string' || !value.connector.assetId || value.connector.assetId.length > 128 || /[\x00-\x20\x7f]/.test(value.connector.assetId) || value.connector.assetId.includes('://') || !Number.isSafeInteger(value.connector.version) || Number(value.connector.version) < 1
        || !sha(value.connector.manifest) || typeof value.connector.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.connector.sourceCommit)) return undefined;
    const status = input.kind === 'get-opencode-provider-status';
    const extra = status ? ['state', 'ready', 'missingFields', 'revision', 'checkedAt'] : input.kind === 'open-opencode-provider' ? ['preparationId', 'opened', 'expiresAt'] : ['preparationId', 'expiresAt'];
    if (Object.keys(value).length !== identityKeys.length + extra.length || Object.keys(value).some(key => ![...identityKeys, ...extra].includes(key))) return undefined;
    if (status) {
        if ((typeof value.state !== 'string' || !['missing', 'configured', 'login-required', 'unavailable', 'conflict'].includes(value.state)) || typeof value.ready !== 'boolean'
            || value.ready !== (value.state === 'configured') || !Array.isArray(value.missingFields) || value.missingFields.length > 3
            || new Set(value.missingFields).size !== value.missingFields.length || value.missingFields.some(key => typeof key !== 'string' || !['baseUrl', 'credential', 'login'].includes(key))
            || value.ready && value.missingFields.length > 0 || value.revision !== null && !uuid(value.revision) || !iso(value.checkedAt) || Date.parse(value.checkedAt) > Date.now() + 60000) return undefined;
    } else if (!uuid(value.preparationId) || !iso(value.expiresAt) || Date.parse(value.expiresAt) > Date.now() + 16 * 60000
        || input.kind === 'open-opencode-provider' && (value.opened !== true || value.preparationId !== preparationId)) return undefined;
    return structuredClone(value) as unknown as TProviderReport;
}

/** Reopened windows use only matching public jobs; malformed records never grant readiness. */
export function matchingProviderJobs(jobs: IBridgeJob[], selection: IProviderSetupSelection | undefined): IProviderSetupJob[] {
    if (!selection) return [];
    return jobs.filter(job => ['prepare-opencode-provider', 'open-opencode-provider', 'get-opencode-provider-status'].includes(job.kind))
        .map(job => providerJob(job, {...selection, kind: job.kind})).filter((job): job is IProviderSetupJob => !!job)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
export function latestProviderStatus(jobs: IProviderSetupJob[], selection: IProviderSetupSelection | undefined): OpenCodeProviderStatus | undefined {
    if (!selection) return;
    const job = jobs.find(item => item.kind === 'get-opencode-provider-status');
    const opened = jobs.find(item => item.kind === 'open-opencode-provider');
    if (!job || job.state !== 'succeeded' || opened && Date.parse(opened.updatedAt) >= Date.parse(job.updatedAt)) return;
    return providerReport(job, {...selection, kind: 'get-opencode-provider-status', requestKey: job.id}) as OpenCodeProviderStatus | undefined;
}
