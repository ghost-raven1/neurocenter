export type TSnapshotStatus = 'UPLOADING' | 'VERIFYING' | 'VERIFIED' | 'REJECTED' | 'DELETING' | 'DELETED';

export interface IProjectSnapshot {
    snapshotId: string;
    storeId: string;
    parentId: string | null;
    status: TSnapshotStatus;
    author: string;
    createdAt: string;
    bytes: number;
    formatVersion: string;
    isHead: boolean;
    pinned: boolean;
    manifestSha256: string | null;
    error: string | null;
    jobId: string | null;
}

export interface ISnapshotProfile {
    profileId: string;
    snapshotId: string;
    revision: number;
    isActive: boolean;
    skillPins: ISkillPin[];
    capsuleSha256: string;
    createdAt: string;
}

export interface ISnapshotCapabilities {
    available: boolean;
    reason: string | null;
    format: string;
    chunkBytes: number;
    maxBytes: number;
}

export interface ISnapshotHeadInput {
    expectedHeadId: string | null;
    expectedHeadRevision: number;
}

export interface ISnapshotCreate extends ISnapshotHeadInput {
    requestKey: string;
    deviceId: string;
    expectedBindingId: string;
}

export type TSnapshotIntent =
    | { projectId: string; kind: 'create'; input: ISnapshotCreate }
    | {
          projectId: string;
          kind: 'activate' | 'rollback';
          snapshotId: string;
          input: ISnapshotHeadInput & { requestKey: string };
      }
    | {
          projectId: string;
          kind: 'delete';
          snapshotId: string;
          input: { requestKey: string; expectedManifest: string | null; gracePeriodHours: number };
      }
    | { projectId: string; kind: 'cancel'; snapshotId: string; input: { requestKey: string } }
    | {
          projectId: string;
          kind: 'release';
          input: {
              requestKey: string;
              snapshotId: string;
              expectedProfileId: string | null;
              expectedProfileRevision: number;
              moveHead?: ISnapshotHeadInput;
          };
      };

export type TSnapshotReceipt =
    | IProjectSnapshot
    | { headId: string; headRevision: number }
    | { snapshotId: string; status: string; gracePeriodHours?: number }
    | { profileId: string; profileRevision: number; head: { headId: string; headRevision: number } | null };

/** Contract owned by interfaces. */
export interface ISkillPin {
    id: string;
    version: number;
    manifest: string;
}
