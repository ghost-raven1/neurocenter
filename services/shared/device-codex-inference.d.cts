export const DEVICE_CODEX_PROTOCOL: 'device-codex-inference-v1';
export const DEVICE_CODEX_CAPABILITY: typeof DEVICE_CODEX_PROTOCOL;
export const DEVICE_CODEX_JOB: 'infer-device-codex';
export type DeviceCodexSource = {
    scope: 'global';
} | {
    scope: 'project';
    projectId: string;
    bindingId: string;
    instanceId: string;
};
export interface DeviceCodexPayload {
    protocol: typeof DEVICE_CODEX_PROTOCOL;
    callId: string;
    modelId: string;
    modelPin: string;
    connectionRevision: number;
    source: DeviceCodexSource;
    deadlineAt: string;
}
export interface DeviceCodexMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    images?: string[];
}
export interface DeviceCodexRequest {
    messages: DeviceCodexMessage[];
    options: {
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
        store?: false;
    };
}
export interface DeviceCodexCandidate {
    provider: string;
    configKey?: string;
    model: string;
    modelVersion: string;
    capability: 'chat' | 'vision';
    baseUrl: string | null;
    options?: import('./opencode-model-scan.cjs').IOpenCodeModelOptions;
}
export interface DeviceCodexContext extends DeviceCodexRequest {
    protocol: typeof DEVICE_CODEX_PROTOCOL;
    callId: string;
    model: string;
    capability: 'chat' | 'vision';
    source: DeviceCodexSource;
    expectedCandidate: DeviceCodexCandidate;
    connectorPackage: Record<string, unknown>;
    deadlineAt: string;
}
export interface DeviceCodexResponse {
    model: string;
    done: true;
    done_reason: 'stop' | 'length';
    message: {
        role: 'assistant';
        content: string;
    };
    prompt_eval_count: number | null;
    eval_count: number | null;
    usage_reported: boolean;
}
export type DeviceCodexResult = {
    protocol: typeof DEVICE_CODEX_PROTOCOL;
    callId: string;
    response: DeviceCodexResponse;
} | {
    protocol: typeof DEVICE_CODEX_PROTOCOL;
    callId: string;
    error: {
        code: 'cancelled' | 'deadline' | 'authorization' | 'unavailable' | 'response' | 'unknown-after-send' | 'runtime-cache-full' | 'disk-full';
    };
};
export function normalizeDeviceCodexPayload(value: unknown): DeviceCodexPayload;
export function deviceCodexCandidateIdentity(candidate: DeviceCodexCandidate): DeviceCodexCandidate;
export function normalizeDeviceCodexRequest(value: unknown, capability: 'chat' | 'vision'): DeviceCodexRequest;
export function normalizeDeviceCodexContext(value: unknown): DeviceCodexContext;
export function normalizeDeviceCodexResult(value: unknown): DeviceCodexResult;
export function deviceCodexResultDigest(value: unknown): string;
