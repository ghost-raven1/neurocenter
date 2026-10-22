import type {OpenCodeProviderDescriptor} from '../../services/shared/opencode-providers.cjs';
import type {useBridge} from '../src/features/McpBridge/useBridge';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';
import type {IProviderSetupJob, IProviderSetupRequest, IProviderSetupSelection} from '../src/features/OpenCodeProviders/types';

export const deviceId = '11111111-1111-4111-8111-111111111111', instanceId = '22222222-2222-4222-8222-222222222222';
export const jobId = '33333333-3333-4333-8333-333333333333', preparationId = '44444444-4444-4444-8444-444444444444';
export const selection: IProviderSetupSelection = {deviceId, projectId: 'prj-test', expectedBindingId: 'a'.repeat(64), expectedInstanceId: instanceId,
    providerKind: 'openai-compatible', catalogModelId: 'model-chat', expectedModelPin: 'b'.repeat(64)};
export const descriptor: OpenCodeProviderDescriptor = {schemaVersion: 1, deviceId, projectId: selection.projectId, bindingId: selection.expectedBindingId,
    instanceId, providerKind: 'openai-compatible', providerId: 'neurocenter-openai-0123456789abcdef', schemaDigest: 'c'.repeat(64),
    expectations: {catalogModelId: 'model-chat', modelPin: 'b'.repeat(64), runtimeModel: 'manual/model', capability: 'chat', baseUrl: 'https://private-provider.example/v1', options: {}}, connector: null};
export const identity = {schemaVersion: descriptor.schemaVersion, deviceId, projectId: descriptor.projectId, bindingId: descriptor.bindingId, instanceId,
    providerKind: descriptor.providerKind, providerId: descriptor.providerId, schemaDigest: descriptor.schemaDigest, connector: null, catalogModelId: 'model-chat', modelPin: 'b'.repeat(64)};
export const model: ICatalogModel = {id: 'model-chat', name: 'Ручная API-модель', description: '', capability: 'chat', runtime: 'remote-openai', model: 'manual/model',
    manifestSha256: null, verificationSha256: 'd'.repeat(64), dimension: null, source: 'custom', revision: 1, createdAt: '', updatedAt: '', modelPin: 'b'.repeat(64)};
export function ack(input: IProviderSetupRequest, patch: Partial<IProviderSetupJob> = {}): IProviderSetupJob {
    const now = new Date().toISOString();
    return {id: jobId, deviceId, projectId: selection.projectId, bindingId: selection.expectedBindingId, expectedInstanceId: instanceId, kind: input.kind,
        state: 'queued', message: '', createdAt: now, updatedAt: now, providerKind: 'openai-compatible', providerId: descriptor.providerId,
        providerSchemaDigest: descriptor.schemaDigest, catalogModelId: 'model-chat', expectedModelPin: 'b'.repeat(64), ...patch};
}
export function preparation() {return {...identity, preparationId, expiresAt: new Date(Date.now() + 600000).toISOString()};}
export function configured() {return {...identity, state: 'configured', ready: true, missingFields: [], revision: preparationId, checkedAt: new Date().toISOString()};}
export function bridgeFixture(): ReturnType<typeof useBridge> {
    const device = {id: deviceId, name: 'Ноутбук Алексея', role: 'Разработчик', fingerprint: '', online: true, lastSeen: null,
        report: {runtimeArtifactTarget: 'darwin-arm64', protocolVersion: 2, capabilities: ['durable-completions', 'managed-installations', 'opencode-providers-v1'],
            bindings: [{projectId: selection.projectId, folderName: 'папка-проекта', bindingId: selection.expectedBindingId, instanceId, valid: true}]}};
    return {devices: [device], device, jobs: [], installations: [], error: '', errors: {devices: '', jobs: '', installations: ''},
        devicesReady: true, jobsReady: true, installationsReady: true, loading: false, reload: async () => undefined, choose: () => undefined};
}
