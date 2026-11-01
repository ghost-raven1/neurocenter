export const OPENCODE_PERSONAL_KEY_JOB: 'open-opencode-personal-key';
export const OPENCODE_PERSONAL_KEY_CAPABILITY: 'opencode-personal-key-v1';
export const OPENCODE_PERSONAL_KEY_VERSION: '1.14.48';
export const OPENCODE_PERSONAL_KEY_PROVIDER_URL: 'https://api.openai.com/v1';
export interface IOpenCodePersonalKeyRequest {
    kind: typeof OPENCODE_PERSONAL_KEY_JOB;
    deviceId: string;
    scope: 'global';
    requestKey: string;
    modelId: string;
    providerId: string;
    expectedConnectionRevision: number;
    expectedCredentialRevision: number;
}
export interface IOpenCodePersonalKeyPayload extends Omit<IOpenCodePersonalKeyRequest, 'kind'> {
    schemaVersion: 1;
    expiresAt: string;
}
export interface IOpenCodePersonalKeyTarget {
    ownerEmail: string;
    modelId: string;
    modelName: string;
    providerId: string;
    providerUrl: typeof OPENCODE_PERSONAL_KEY_PROVIDER_URL;
    connectionRevision: number;
    credentialRevision: number;
    authMode: 'optional' | 'required';
    canStoreKey: boolean;
}
export interface IOpenCodePersonalKeyContext {
    ok: true;
    expiresAt: string;
    requestKey: string;
    recipient: IOpenCodePersonalKeyTarget;
}
export interface IOpenCodePersonalKeyReceipt {
    schemaVersion: 1;
    jobId: string;
    requestKey: string;
    modelId: string;
    providerId: string;
    connectionRevision: number;
    credentialRevision: number;
    hasKey: true;
    acceptedAt: string;
}
export type TOpenCodePersonalKeyIssue =
    'unsupported-version' | 'source-changed' | 'permission-denied' | 'session-unavailable' | 'cancelled' | 'unknown';
export type TOpenCodePersonalKeyResult = {
    schemaVersion: 1;
    scope: 'global';
    deviceId: string;
    jobId: string;
    kind: typeof OPENCODE_PERSONAL_KEY_JOB;
    checkedAt: string;
} & ({ status: 'opened'; expiresAt: string } | { status: 'failed'; issue: TOpenCodePersonalKeyIssue });
export function normalizeOpenCodePersonalKeyRequest(value: unknown): IOpenCodePersonalKeyRequest;
export function normalizeOpenCodePersonalKeyPayload(value: unknown): IOpenCodePersonalKeyPayload;
export function normalizeOpenCodePersonalKeyResult(
    value: unknown,
    expected?: { deviceId: string; jobId: string; kind: string; expiresAt?: string },
): TOpenCodePersonalKeyResult;
export function normalizeOpenCodePersonalKeyReceipt(value: unknown): IOpenCodePersonalKeyReceipt;

export function normalizeOpenCodePersonalKeyContext(value: unknown): IOpenCodePersonalKeyContext;

export const OPENCODE_PERSONAL_KEY_SCHEMAS: {
    request: Record<string, unknown>;
    payload: Record<string, unknown>;
    result: Record<string, unknown>;
    receipt: Record<string, unknown>;
    context: Record<string, unknown>;
};

export interface IOpenCodePersonalKeyBrowserReceipt {
    receipt: IOpenCodePersonalKeyReceipt | null;
    canStartNew: boolean;
}
