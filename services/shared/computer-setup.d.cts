/** CLI device and job identities use canonical lowercase UUID strings. */
export const OPENCODE_CLI_INSPECT_JOB: 'inspect-opencode-cli';
export const OPENCODE_CLI_CAPABILITY: 'opencode-cli-v1';
export const OPENCODE_CLI_SCHEMAS: {
    request: Record<string, unknown>;
    payload: Record<string, unknown>;
    observation: Record<string, unknown>;
};
export interface IOpenCodeCliRequest {
    deviceId: string;
    kind: 'inspect-opencode-cli';
    scope: 'global';
    requestKey: string;
}
export interface IOpenCodeCliPayload {
    schemaVersion: 1;
    scope: 'global';
    deviceId: string;
}
interface IOpenCodeCliObservation {
    schemaVersion: 1;
    scope: 'global';
    deviceId: string;
    jobId: string;
    checkedAt: string;
}
export type TOpenCodeCliResult = IOpenCodeCliObservation &
    ({ status: 'installed'; version: string } | { status: 'missing' | 'failed' | 'timed-out' });
export function normalizeOpenCodeCliRequest(value: unknown): IOpenCodeCliRequest;
export function normalizeOpenCodeCliPayload(value: unknown): IOpenCodeCliPayload;
export function normalizeOpenCodeCliResult(
    value: unknown,
    expected?: { deviceId: string; jobId: string },
): TOpenCodeCliResult;
