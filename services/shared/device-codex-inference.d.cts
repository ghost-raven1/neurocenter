export const DEVICE_CODEX_PROTOCOL: 'device-codex-inference-v1';
export const DEVICE_CODEX_CAPABILITY: typeof DEVICE_CODEX_PROTOCOL;
export const DEVICE_CODEX_DISPATCH_CAPABILITY: 'device-codex-dispatch-features-v1';
export const DEVICE_CODEX_JOB: 'infer-device-codex';
export type TDeviceCodexSource =
    | {
          scope: 'global';
      }
    | {
          scope: 'project';
          projectId: string;
          bindingId: string;
          instanceId: string;
      };
export interface IDeviceCodexPayload {
    protocol: typeof DEVICE_CODEX_PROTOCOL;
    callId: string;
    modelId: string;
    modelPin: string;
    connectionRevision: number;
    source: TDeviceCodexSource;
    deadlineAt: string;
    /** Immutable feature gates checked only before the first physical dispatch marker. */
    dispatchOnlyFeatures?: import('./feature-flags.cjs').TFeatureFlagKey[];
}
export interface IDeviceCodexMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    images?: string[];
}
export interface IDeviceCodexRequest {
    messages: IDeviceCodexMessage[];
    options: {
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
        store?: false;
    };
}
export interface IDeviceCodexCandidate {
    provider: string;
    configKey?: string;
    model: string;
    modelVersion: string;
    capability: 'chat' | 'vision';
    baseUrl: string | null;
    options?: import('./opencode-model-scan.cjs').IOpenCodeModelOptions;
}
export interface IDeviceCodexContext extends IDeviceCodexRequest {
    protocol: typeof DEVICE_CODEX_PROTOCOL;
    callId: string;
    model: string;
    capability: 'chat' | 'vision';
    source: TDeviceCodexSource;
    expectedCandidate: IDeviceCodexCandidate;
    connectorPackage: Record<string, unknown>;
    deadlineAt: string;
}
export interface IDeviceCodexResponse {
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
export type TDeviceCodexResult =
    | {
          protocol: typeof DEVICE_CODEX_PROTOCOL;
          callId: string;
          response: IDeviceCodexResponse;
      }
    | {
          protocol: typeof DEVICE_CODEX_PROTOCOL;
          callId: string;
          error: {
              code:
                  | 'cancelled'
                  | 'deadline'
                  | 'authorization'
                  | 'unavailable'
                  | 'response'
                  | 'unknown-after-send'
                  | 'runtime-cache-full'
                  | 'disk-full';
          };
      };
export function normalizeDeviceCodexPayload(value: unknown): IDeviceCodexPayload;
export function deviceCodexCandidateIdentity(candidate: IDeviceCodexCandidate): IDeviceCodexCandidate;
export function normalizeDeviceCodexRequest(value: unknown, capability: 'chat' | 'vision'): IDeviceCodexRequest;
export function normalizeDeviceCodexContext(value: unknown): IDeviceCodexContext;
export function normalizeDeviceCodexResult(value: unknown): TDeviceCodexResult;
export function deviceCodexResultDigest(value: unknown): string;
