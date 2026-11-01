export type TOpenCodeProviderKind = 'openai-compatible' | 'ollama' | 'codex-bridge';
export type TOpenCodeProviderJobKind =
    'prepare-opencode-provider' | 'open-opencode-provider' | 'get-opencode-provider-status';
export interface IOpenCodeProviderExpectations {
    catalogModelId: string;
    modelPin: string;
    runtimeModel: string;
    capability: 'chat' | 'vision';
    baseUrl: string;
    options: { temperature?: number; topP?: number; maxOutputTokens?: number; contextWindow?: number };
}
export interface IOpenCodeConnectorReference {
    assetId: string;
    version: number;
    manifest: string;
    sourceCommit: string;
}
export interface IOpenCodeProviderDescriptor {
    schemaVersion: 1;
    deviceId: string;
    projectId: string;
    bindingId: string;
    instanceId: string;
    providerKind: TOpenCodeProviderKind;
    providerId: string;
    schemaDigest: string;
    expectations: IOpenCodeProviderExpectations | null;
    connector: IOpenCodeConnectorReference | null;
}
export interface IOpenCodeProviderIdentity extends Omit<IOpenCodeProviderDescriptor, 'expectations'> {
    catalogModelId: string | null;
    modelPin: string | null;
}
export interface IOpenCodeProviderPreparation extends IOpenCodeProviderIdentity {
    preparationId: string;
    expiresAt: string;
}
export interface IOpenCodeProviderOpened extends IOpenCodeProviderPreparation {
    opened: true;
}
export interface IOpenCodeProviderStatus extends IOpenCodeProviderIdentity {
    state: 'missing' | 'configured' | 'login-required' | 'unavailable' | 'conflict';
    ready: boolean;
    missingFields: Array<'baseUrl' | 'credential' | 'login'>;
    revision: string | null;
    checkedAt: string;
}
export const OPENCODE_PROVIDER_CAPABILITY: 'opencode-providers-v1';
export const OPENCODE_OLLAMA_CAPABILITY: 'opencode-ollama-v1';
export const OPENCODE_PROVIDER_JOBS: TOpenCodeProviderJobKind[];
export function normalizeProviderDescriptor(value: unknown): IOpenCodeProviderDescriptor;
export function providerReportIdentity(value: unknown): IOpenCodeProviderIdentity;
export function normalizeProviderReport(
    kind: string,
    value: unknown,
    descriptor: unknown,
    failed?: boolean,
    preparationId?: string,
): IOpenCodeProviderPreparation | IOpenCodeProviderOpened | IOpenCodeProviderStatus | Record<string, never>;
