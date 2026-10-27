import {serviceIntentScope} from './intent';
import type {SystemRoleId} from '../SystemRoles/types';

const drafts = new Map<string, string>();
const key = (scope: string, projectId: string | undefined, agentId: SystemRoleId): string =>
    'neurocenter:role-chat-draft:' + serviceIntentScope(scope, projectId, agentId);

/** Drafts follow their person/project/role; restored context always requires fresh preparation. */
export function readRoleDraft(scope: string, projectId: string | undefined, agentId: SystemRoleId): string {
    const id = key(scope, projectId, agentId);
    try { return drafts.get(id) ?? sessionStorage.getItem(id) ?? ''; } catch { return drafts.get(id) ?? ''; }
}
export function saveRoleDraft(scope: string, projectId: string | undefined, agentId: SystemRoleId, instruction: string): void {
    const id = key(scope, projectId, agentId); drafts.set(id, instruction);
    try { if (instruction) sessionStorage.setItem(id, instruction); else sessionStorage.removeItem(id); } catch { /* Editing remains available in this mounted session. */ }
}
export function clearRoleDraft(scope: string, projectId: string | undefined, agentId: SystemRoleId): void {saveRoleDraft(scope, projectId, agentId, '');}
