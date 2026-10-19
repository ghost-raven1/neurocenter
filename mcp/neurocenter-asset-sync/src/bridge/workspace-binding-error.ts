import { WorkspaceIdentityError } from './workspace-instance.model.js';

export const WORKSPACE_BINDING_FAILURE_CODES = ['invalid-selection', 'root-required', 'folder-unavailable', 'permission-denied',
    'foreign-binding', 'marker-missing', 'marker-invalid', 'recovery-required', 'legacy-binding', 'copied-folder',
    'resume-required', 'source-unavailable', 'preparation-stale', 'installation-mismatch', 'unknown'] as const;
export type WorkspaceBindingFailureCode = typeof WORKSPACE_BINDING_FAILURE_CODES[number];

/** В сеть уходит только код отказа; локальное сообщение и пути остаются на компьютере. */
export class WorkspaceBindingError extends Error {
    constructor(public readonly code: WorkspaceBindingFailureCode, message: string) { super(message); }
}

/** Неизвестные исключения и системные сообщения не превращаются в публичную диагностику. */
export function workspaceBindingFailure(error: unknown): WorkspaceBindingFailureCode {
    if (error instanceof WorkspaceBindingError && WORKSPACE_BINDING_FAILURE_CODES.includes(error.code)) { return error.code; }
    if (error instanceof WorkspaceIdentityError) {
        return { legacy: 'legacy-binding', copied: 'copied-folder', changed: 'preparation-stale', unavailable: 'folder-unavailable', verified: 'unknown' }[error.identityStatus] as WorkspaceBindingFailureCode;
    }
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'EACCES' || code === 'EPERM') { return 'permission-denied'; }
    if (code === 'ENOENT' || code === 'ENOTDIR') { return 'folder-unavailable'; }
    return 'unknown';
}

/** Старый сервер продолжает получать прежний пустой результат отказа. */
export function workspaceBindingFailureResult(kind: string, version: unknown, error: unknown): { workspaceFailure?: WorkspaceBindingFailureCode } {
    return version === 1 && ['prepare-bind-project', 'bind-project'].includes(kind) ? { workspaceFailure: workspaceBindingFailure(error) } : {};
}
