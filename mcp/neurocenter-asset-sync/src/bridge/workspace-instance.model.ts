import type { IMemoryOwnershipHandoff } from '../features/project-learning-memory-sync/workspace-handoff.js';

export type TWorkspaceBindingMode = 'new' | 'new-copy' | 'adopt-legacy' | 'transfer' | 'resume';
export interface IWorkspaceBindingInput {
    projectId: string;
    folderName: string;
    mode?: TWorkspaceBindingMode;
    expectedBindingId?: string;
    expectedInstanceId?: string;
}
export interface IWorkspaceBindingPreparation extends IWorkspaceBindingInput {
    mode: TWorkspaceBindingMode;
    preparation: string;
    requiresFileVerification: boolean;
    instanceId?: string;
    previousBindingId?: string;
    sourceFolderName?: string;
}
export interface IWorkspaceBindingResult {
    projectId: string;
    folderName: string;
    mode: TWorkspaceBindingMode;
    preparation: string;
    instanceId: string;
    bindingId: string;
    previousBindingId?: string;
}
/** Пути доступны только локальной проверке; результат задания их не содержит. */
export interface IWorkspaceFileVerification {
    projectId: string;
    mode: TWorkspaceBindingMode;
    targetRoot: string;
    sourceRoot?: string;
    previousConfigRoot?: string;
    previousBindingId?: string;
    instanceId?: string;
    bindingId?: string;
    assertUnchanged(): Promise<void>;
}
/** Возвращённый release удерживает внешние locks до окончания commit, включая ошибку. */
export type TWorkspaceVerificationRelease = (() => Promise<void>) & { memoryOwnership?: IMemoryOwnershipHandoff[] };
export type TVerifyWorkspaceFiles = (
    context: IWorkspaceFileVerification,
) => Promise<void | TWorkspaceVerificationRelease>;
export interface IWorkspaceMarker {
    version: 1 | 2;
    server: string;
    projectId: string;
    instanceId?: string;
}
export interface IPhysicalDirectory {
    dev: string;
    ino: string;
    birthtimeNs: string;
}
export interface IWorkspaceInstance {
    instanceId: string;
    projectId: string;
    server: string;
    realpath: string;
    physical: IPhysicalDirectory;
    bindingNonce: string;
}
export interface IWorkspaceInstanceRegistry {
    version: 1;
    instances: Record<string, IWorkspaceInstance>;
}
export type TWorkspaceIdentityStatus = 'verified' | 'legacy' | 'copied' | 'changed' | 'unavailable';
export class WorkspaceIdentityError extends Error {
    constructor(
        public readonly identityStatus: TWorkspaceIdentityStatus,
        message: string,
    ) {
        super(message);
    }
}
