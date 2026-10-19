export type WorkspaceBindingMode = 'new' | 'new-copy' | 'adopt-legacy' | 'transfer' | 'resume';
export interface WorkspaceBindingInput {
    projectId: string;
    folderName: string;
    mode?: WorkspaceBindingMode;
    expectedBindingId?: string;
    expectedInstanceId?: string;
}
export interface WorkspaceBindingPreparation extends WorkspaceBindingInput {
    mode: WorkspaceBindingMode;
    preparation: string;
    requiresFileVerification: boolean;
    instanceId?: string;
    previousBindingId?: string;
    sourceFolderName?: string;
}
export interface WorkspaceBindingResult {
    projectId: string;
    folderName: string;
    mode: WorkspaceBindingMode;
    preparation: string;
    instanceId: string;
    bindingId: string;
    previousBindingId?: string;
}
/** Пути доступны только локальной проверке; результат задания их не содержит. */
export interface WorkspaceFileVerification {
    projectId: string;
    mode: WorkspaceBindingMode;
    targetRoot: string;
    sourceRoot?: string;
    previousConfigRoot?: string;
    previousBindingId?: string;
    instanceId?: string;
    assertUnchanged(): Promise<void>;
}
/** Возвращённый release удерживает внешние locks до окончания commit, включая ошибку. */
export type VerifyWorkspaceFiles = (context: WorkspaceFileVerification) => Promise<void | (() => Promise<void>)>;
export interface WorkspaceMarker {
    version: 1 | 2;
    server: string;
    projectId: string;
    instanceId?: string;
}
export interface PhysicalDirectory {
    dev: string;
    ino: string;
    birthtimeNs: string;
}
export interface WorkspaceInstance {
    instanceId: string;
    projectId: string;
    server: string;
    realpath: string;
    physical: PhysicalDirectory;
    bindingNonce: string;
}
export interface WorkspaceInstanceRegistry {
    version: 1;
    instances: Record<string, WorkspaceInstance>;
}
export type WorkspaceIdentityStatus = 'verified' | 'legacy' | 'copied' | 'changed' | 'unavailable';
export class WorkspaceIdentityError extends Error {
    constructor(public readonly identityStatus: WorkspaceIdentityStatus, message: string) { super(message); }
}
