/**
 * Типы событий Socket.io (live-обновления операций и версий).
 */

export interface IOperationProgress {
    operationId: string;
    percent: number;
    bytesDone: number;
    bytesTotal: number;
}

export interface IOperationStateEvent {
    operationId: string;
    state: string;
}

export interface IVersionVerified {
    projectId: string;
    snapshotId: string;
}

export interface IVersionRejected {
    projectId: string;
    snapshotId: string;
    reason: string;
}

export interface IHeadMoved {
    projectId: string;
    headId: string;
    headRevision: number;
    actor: string;
}

export interface IProfilePublished {
    projectId: string;
    profileId: string;
    profileRevision: number;
}

export interface ISkillChanged {
    skillPath: string;
    kind: 'created' | 'updated' | 'deleted';
}

export interface IPackageChanged {
    packageId: string;
    collectionId: string;
    newHeadVersionId: string;
}

export type TLiveSection =
    | 'projects'
    | 'catalog'
    | 'knowledge'
    | 'access'
    | 'maintenance'
    | 'audit'
    | 'operations'
    | 'bridge'
    | 'requests'
    | 'project_chat';
