export const OPENCODE_GLOBAL_PROVIDERS_READ_JOB: 'inspect-opencode-global-providers';
export const OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB: 'open-opencode-global-providers';
export const OPENCODE_GLOBAL_PROVIDERS_CAPABILITY: 'opencode-global-providers-v1';
export const OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION: '1.14.48';
export const OPENCODE_GLOBAL_PROVIDERS_SCHEMAS: {
    request: Record<string, unknown>;
    payloadRead: Record<string, unknown>;
    payloadOpen: Record<string, unknown>;
    inventory: Record<string, unknown>;
    results: Record<string, unknown>;
};
export type TGlobalProvidersKind =
    typeof OPENCODE_GLOBAL_PROVIDERS_READ_JOB | typeof OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB;
export type TGlobalProvidersIssue =
    | 'invalid-json'
    | 'unsafe-file'
    | 'source-changed'
    | 'environment-override'
    | 'entry-limit'
    | 'read-failed'
    | 'permission-denied'
    | 'cancelled'
    | 'session-unavailable'
    | 'unsupported-version'
    | 'unknown';
export interface IGlobalProvider {
    id: string;
    modelIds: string[];
    hasConfiguration: boolean;
    hasAuthentication: boolean;
    authentication: 'api' | 'oauth' | 'wellknown' | 'reference' | 'none' | 'unknown';
    enabled: boolean;
}
export interface IOpenCodeGlobalProvidersInventory {
    providers: IGlobalProvider[];
    configurationFound: boolean;
    authenticationFound: boolean;
    overrideDetected: boolean;
    issues: TGlobalProvidersIssue[];
}
export interface IOpenCodeGlobalProvidersRequest {
    deviceId: string;
    kind: TGlobalProvidersKind;
    scope: 'global';
    requestKey: string;
}
export interface IOpenCodeGlobalProvidersPayload {
    schemaVersion: 1;
    scope: 'global';
    deviceId: string;
    expiresAt?: string;
}
interface IIdentity extends IOpenCodeGlobalProvidersPayload {
    jobId: string;
    checkedAt: string;
    kind: TGlobalProvidersKind;
}
export type TOpenCodeGlobalProvidersResult = IIdentity &
    (
        | { status: 'checked' | 'partial'; inventory: IOpenCodeGlobalProvidersInventory }
        | { status: 'opened'; expiresAt: string }
        | { status: 'failed'; issue: TGlobalProvidersIssue }
    );
export interface IGlobalProvidersLimits {
    fileBytes: number;
    providers: number;
    modelsPerProvider: number;
    secretBytes: number;
    sessionMs: number;
    requestBytes: number;
    publicBytes: number;
    httpRequestMs: number;
    httpHeadersMs: number;
    httpHeadersCount: number;
    sessions: number;
}
export const DEFAULT_GLOBAL_PROVIDERS_LIMITS: Readonly<IGlobalProvidersLimits>;
export function globalProvidersLimits(env?: Record<string, string | undefined>): Readonly<IGlobalProvidersLimits>;
export function normalizeGlobalProvidersRequest(value: unknown): IOpenCodeGlobalProvidersRequest;
export function normalizeGlobalProvidersPayload(value: unknown, kind?: string): IOpenCodeGlobalProvidersPayload;
export function normalizeGlobalProvidersInventory(value: unknown): IOpenCodeGlobalProvidersInventory;
export function normalizeGlobalProvidersResult(
    value: unknown,
    expected?: { deviceId: string; jobId: string; kind: string; expiresAt?: string },
): TOpenCodeGlobalProvidersResult;
export function globalProviderId(value: unknown): value is string;
export function globalProviderModelId(value: unknown): value is string;
