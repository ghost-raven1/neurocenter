import type {SystemRoleId} from '../SystemRoles/types';
import {serviceIntentScope} from './intent';

const selected = new Map<string, string | null>();
const key = (scope: string, projectId: string | undefined, agentId: SystemRoleId): string =>
    'neurocenter:role-chat-model:' + serviceIntentScope(scope, projectId, agentId);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** Only the model ID follows the draft's person/project/role; null preserves an explicit clear. */
export function readRoleModelPreference(scope: string, projectId: string | undefined, agentId: SystemRoleId): string | null | undefined {
    const id = key(scope, projectId, agentId);
    if (selected.has(id)) return selected.get(id);
    try {
        const raw = sessionStorage.getItem(id); if (!raw || raw.length > 1024) return undefined;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const record = value as Record<string, unknown>;
        if (record.version !== 1 || Object.keys(record).length !== 2 || record.modelId !== null && !identifier(record.modelId)) return undefined;
        selected.set(id, record.modelId as string | null); return record.modelId as string | null;
    } catch { return undefined; }
}

/** Blocked storage keeps the explicit choice usable in this tab without changing a pending request. */
export function saveRoleModelPreference(scope: string, projectId: string | undefined, agentId: SystemRoleId, modelId: string | undefined): void {
    if (modelId !== undefined && !identifier(modelId)) return;
    const id = key(scope, projectId, agentId), value = modelId ?? null;
    selected.set(id, value);
    try {sessionStorage.setItem(id, JSON.stringify({version: 1, modelId: value}));} catch { /* Keep editing available when browser storage is blocked. */ }
}
