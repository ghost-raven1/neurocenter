import type { ISnapshotManifest } from '../../../shared/project-snapshot.cjs';
import type { IImageVersion, ISkillPin } from '../catalog/dto';
export interface ISnapshotSignature {
    algorithm: 'Ed25519';
    keyId: string;
    publicKey: string;
    value: string;
}
export interface ISnapshotRow {
    id: string;
    project_id: string;
    email: string;
    role: string;
    device_id: string;
    binding_id: string;
    parent_id: string | null;
    expected_head_id: string | null;
    expected_head_revision: string;
    status: 'UPLOADING' | 'VERIFYING' | 'VERIFIED' | 'REJECTED' | 'DELETING' | 'DELETED';
    manifest: ISnapshotManifest | null;
    manifest_sha256: string | null;
    signature: ISnapshotSignature | null;
    total_bytes: string;
    job_id: string | null;
    upload_completed_at: Date | null;
    created_at: Date;
    verified_at: Date | null;
    error: string | null;
}
export interface ISnapshotView extends Omit<IImageVersion, 'status'> {
    status: ISnapshotRow['status'];
    manifestSha256: string | null;
    error: string | null;
    jobId: string | null;
}
export interface ISnapshotHead {
    expectedHeadId: string | null;
    expectedHeadRevision: number;
}
export interface ISnapshotCreate extends ISnapshotHead {
    requestKey: string;
    deviceId: string;
    expectedBindingId: string;
}
export interface ISnapshotCommand {
    requestKey: string;
}
export interface ISnapshotProfileInput extends ISnapshotCommand {
    snapshotId: string;
    skillPins: ISkillPin[];
    expectedProfileId: string | null;
    expectedProfileRevision: number;
    moveHead?: ISnapshotHead;
}
