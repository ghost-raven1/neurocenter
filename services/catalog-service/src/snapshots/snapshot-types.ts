import type { SnapshotManifest } from '../../../shared/project-snapshot.cjs';
import type { IImageVersion, ISkillPin } from '../catalog/dto';
export interface SnapshotSignature {
    algorithm: 'Ed25519';
    keyId: string;
    publicKey: string;
    value: string;
}
export interface SnapshotRow {
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
    manifest: SnapshotManifest | null;
    manifest_sha256: string | null;
    signature: SnapshotSignature | null;
    total_bytes: string;
    job_id: string | null;
    upload_completed_at: Date | null;
    created_at: Date;
    verified_at: Date | null;
    error: string | null;
}
export interface SnapshotView extends Omit<IImageVersion, 'status'> {
    status: SnapshotRow['status'];
    manifestSha256: string | null;
    error: string | null;
    jobId: string | null;
}
export interface SnapshotHead {
    expectedHeadId: string | null;
    expectedHeadRevision: number;
}
export interface SnapshotCreate extends SnapshotHead {
    requestKey: string;
    deviceId: string;
    expectedBindingId: string;
}
export interface SnapshotCommand {
    requestKey: string;
}
export interface SnapshotProfileInput extends SnapshotCommand {
    snapshotId: string;
    skillPins: ISkillPin[];
    expectedProfileId: string | null;
    expectedProfileRevision: number;
    moveHead?: SnapshotHead;
}
