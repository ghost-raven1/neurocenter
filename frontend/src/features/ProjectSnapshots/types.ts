import type {ISkillPin} from '../../core/api/interfaces';
export type SnapshotStatus='UPLOADING'|'VERIFYING'|'VERIFIED'|'REJECTED'|'DELETING'|'DELETED';
export interface ProjectSnapshot {
    snapshotId:string;storeId:string;parentId:string|null;status:SnapshotStatus;author:string;createdAt:string;
    bytes:number;formatVersion:string;isHead:boolean;pinned:boolean;manifestSha256:string|null;error:string|null;jobId:string|null;
}
export interface SnapshotProfile {
    profileId:string;snapshotId:string;revision:number;isActive:boolean;skillPins:ISkillPin[];
    capsuleSha256:string;createdAt:string;
}
export interface SnapshotCapabilities {available:boolean;reason:string|null;format:string;chunkBytes:number;maxBytes:number}
export interface SnapshotHeadInput {expectedHeadId:string|null;expectedHeadRevision:number}
export interface SnapshotCreate extends SnapshotHeadInput {requestKey:string;deviceId:string;expectedBindingId:string}
export type SnapshotIntent=
    |{projectId:string;kind:'create';input:SnapshotCreate}
    |{projectId:string;kind:'activate'|'rollback';snapshotId:string;input:SnapshotHeadInput&{requestKey:string}}
    |{projectId:string;kind:'delete';snapshotId:string;input:{requestKey:string;expectedManifest:string|null;gracePeriodHours:number}}
    |{projectId:string;kind:'cancel';snapshotId:string;input:{requestKey:string}}
    |{projectId:string;kind:'release';input:{requestKey:string;snapshotId:string;expectedProfileId:string|null;expectedProfileRevision:number;moveHead?:SnapshotHeadInput}};
export type SnapshotReceipt=ProjectSnapshot|{headId:string;headRevision:number}|{snapshotId:string;status:string;gracePeriodHours?:number}|{profileId:string;profileRevision:number;head:{headId:string;headRevision:number}|null};
export const snapshotPending=(snapshot:ProjectSnapshot)=>snapshot.status==='UPLOADING'||snapshot.status==='VERIFYING';
export const snapshotActionLabel:Record<SnapshotIntent['kind'],string>={create:'Создание снимка',activate:'Активация снимка',rollback:'Откат серверного снимка',delete:'Удаление снимка',cancel:'Отмена публикации',release:'Выпуск релизного профиля'};
