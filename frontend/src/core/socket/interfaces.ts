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

/**
 * Словарь событий → обработчиков (типизация `on`/`off`).
 */
export interface TSocketHandlers {
    'connect': () => void;
    'disconnect': () => void;
    'connect_error': () => void;
    'section:changed': (payload: {sections:TLiveSection[];at:string}) => void;
    'bridge:changed': (payload: {deviceId?:string;jobId?:string}) => void;
    'auth:changed': () => void;
    'operation:progress': (payload: IOperationProgress) => void;
    'operation:state': (payload: IOperationStateEvent) => void;
    'version:verified': (payload: IVersionVerified) => void;
    'version:rejected': (payload: IVersionRejected) => void;
    'head:moved': (payload: IHeadMoved) => void;
    'profile:published': (payload: IProfilePublished) => void;
    'skill:changed': (payload: ISkillChanged) => void;
    'package:changed': (payload: IPackageChanged) => void;
}

export type TLiveSection='projects'|'catalog'|'knowledge'|'access'|'maintenance'|'audit'|'operations'|'bridge'|'requests';
