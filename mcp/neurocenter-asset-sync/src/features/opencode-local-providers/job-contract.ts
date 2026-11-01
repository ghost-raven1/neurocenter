import { contract } from './contract.js';
import { contract as personal } from '../opencode-personal-key/contract.js';
import type { IOpenCodeGlobalProvidersPayload } from '../../../../../services/shared/opencode-local-providers.cjs';
import type { IOpenCodePersonalKeyPayload } from '../opencode-personal-key/contract.js';
export const localProviderKinds: readonly string[] = [
    contract.OPENCODE_GLOBAL_PROVIDERS_READ_JOB,
    contract.OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB,
    personal.OPENCODE_PERSONAL_KEY_JOB,
];
/** Shared private-window journal validates each kind with its own bounded contract. */
export function normalizeLocalPayload(
    value: unknown,
    kind: string,
): IOpenCodeGlobalProvidersPayload & Partial<IOpenCodePersonalKeyPayload> {
    return kind === personal.OPENCODE_PERSONAL_KEY_JOB
        ? personal.normalizeOpenCodePersonalKeyPayload(value)
        : contract.normalizeGlobalProvidersPayload(value, kind);
}
export function normalizeLocalResult(
    value: unknown,
    expected?: {
        deviceId: string;
        jobId: string;
        kind: string;
        expiresAt?: string;
        adapter?: typeof contract.OPENCODE_V2_ACCOUNTS_ADAPTER;
    },
) {
    const kind = expected?.kind ?? (value as { kind?: unknown } | null)?.kind;
    return kind === personal.OPENCODE_PERSONAL_KEY_JOB
        ? personal.normalizeOpenCodePersonalKeyResult(value, expected)
        : contract.normalizeGlobalProvidersResult(value, expected);
}
