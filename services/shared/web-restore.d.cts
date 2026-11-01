export interface IRestoreCheckpoint {
    id: string;
    label: string;
    sha256: string;
    createdAt: string;
}
export interface IRestorePreviewInput {
    requestKey: string;
    checkpointId: string;
    checkpointSha256: string;
    targetProject: string;
}
export interface IRestoreInput {
    requestKey: string;
    previewId: string;
    digest: string;
    confirmation: string;
}
export interface IRestoreRunnerReport {
    runnerId: string;
    configDigest: string;
    targetPrefix: string;
    checkpoints: IRestoreCheckpoint[];
}
export interface IRestorePreview {
    checkpointId: string;
    checkpointSha256: string;
    targetProject: string;
    configDigest: string;
    checkedAt: string;
    expiresAt: string;
    impact: {
        databases: string[];
        volumes: string[];
        files: number;
        bytes: number;
        applicationsStarted: false;
        currentStackChanged: false;
    };
    digest: string;
}
export interface IRestoreReceipt {
    ok: true;
    projectName: string;
    sha256: string;
    restoredAt: string;
    databases: number;
    durationMs: number;
    applicationsStarted: false;
}
export function uuid(value: unknown): value is string;
export function sha(value: unknown): value is string;
export function project(value: unknown): value is string;
export function checkpoint(value: unknown): value is string;
export function digest(value: unknown): string;
export function previewRequest(value: unknown): IRestorePreviewInput;
export function restoreRequest(value: unknown): IRestoreInput;
export function checkpointInfo(value: unknown): IRestoreCheckpoint;
export function runnerReport(value: unknown): IRestoreRunnerReport;
export function previewResult(value: unknown): IRestorePreview;
export function restoreReceipt(value: unknown): IRestoreReceipt;
export const restoreFailureMessages: Readonly<Record<string, string>>;
export function restoreFailureCode(error: unknown): string;
