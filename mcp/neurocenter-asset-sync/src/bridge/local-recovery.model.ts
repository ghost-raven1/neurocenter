import type { PackageRef } from './install-set.js';
import type { Journal } from './installation-journal.js';
export type LocalVariantReason =
    | 'ready'
    | 'legacy-unverified'
    | 'different-installation'
    | 'different-instance'
    | 'shared-dependency'
    | 'no-restorable-files'
    | 'invalid-backup'
    | 'limit-exceeded';
export interface LocalVariantEntry {
    recoveryId: string;
    createdAt: string;
    files: number;
    eligible: boolean;
    reason: LocalVariantReason;
}
export interface LocalVariantList {
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
    entries: LocalVariantEntry[];
}
export interface RecoverySource {
    journal: Journal;
    createdAt: string;
    reason: LocalVariantReason;
    packages?: PackageRef[];
}
export class LocalRecoveryError extends Error {
    constructor(readonly reason: LocalVariantReason) {
        super('Локальный вариант недоступен: ' + reason + '. Подготовьте список заново.');
    }
}
