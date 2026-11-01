import type { IPackageRef } from './install-set.js';
import type { IJournal } from './installation-journal.js';
export type TLocalVariantReason =
    | 'ready'
    | 'legacy-unverified'
    | 'different-installation'
    | 'different-instance'
    | 'shared-dependency'
    | 'no-restorable-files'
    | 'invalid-backup'
    | 'limit-exceeded';
export interface ILocalVariantEntry {
    recoveryId: string;
    createdAt: string;
    files: number;
    eligible: boolean;
    reason: TLocalVariantReason;
}
export interface ILocalVariantList {
    schemaVersion: 1;
    projectId: string;
    bindingId: string;
    instanceId: string;
    assetId: string;
    assetKind: string;
    version: number;
    manifest: string;
    checkedAt: string;
    complete: boolean;
    entries: ILocalVariantEntry[];
}
export interface IRecoverySource {
    journal: IJournal;
    createdAt: string;
    reason: TLocalVariantReason;
    packages?: IPackageRef[];
}
export class LocalRecoveryError extends Error {
    constructor(readonly reason: TLocalVariantReason) {
        super('Локальный вариант недоступен: ' + reason + '. Подготовьте список заново.');
    }
}
