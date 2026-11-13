export interface IVerificationCheckCommand {
    command: string;
    args: string[];
}
export type TVerificationCheckState = 'passed' | 'failed' | 'not_run';
export interface IVerificationCheck extends IVerificationCheckCommand {
    exitCode: number | null;
    signal: string | null;
    state: TVerificationCheckState;
}
export type TVerificationState = 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type TVerificationStage = 'prerequisites' | 'execution' | 'checks' | 'completed';
export type TVerificationFailureCode =
    | 'CHECKS_REQUIRED'
    | 'EXECUTION_FAILED'
    | 'CHECK_FAILED'
    | 'AUTHORIZATION_LOST'
    | 'UNKNOWN_OUTCOME'
    | 'CANCELLED'
    | 'TIMEOUT'
    | 'OUTPUT_LIMIT'
    | 'OBSERVATION_LIMIT'
    | 'WORKSPACE_CHANGED'
    | 'PROVENANCE_MISMATCH';
export type TVerificationFailureAction = 'setup-checks' | 'inspect-workspace' | 'review-result' | 'new-request';
export interface IVerificationIntent {
    protocol: 'agent-result-verification-v1';
    checks: IVerificationCheckCommand[];
}
export interface IVerificationResult {
    protocol: 'agent-result-verification-v1';
    state: TVerificationState;
    stage: TVerificationStage;
    changes?: Array<{ path: string; beforeSha256: string | null; afterSha256: string | null }>;
    artifacts?: Array<{ path: string; sha256: string }>;
    checks: IVerificationCheck[];
    failure?: { code: TVerificationFailureCode; action: TVerificationFailureAction };
}
export const AGENT_RESULT_VERIFICATION_PROTOCOL: 'agent-result-verification-v1';
export const VERIFICATION_STATES: readonly TVerificationState[];
export const VERIFICATION_STAGES: readonly TVerificationStage[];
export const VERIFICATION_CHECK_STATES: readonly TVerificationCheckState[];
export const VERIFICATION_FAILURE_CODES: readonly TVerificationFailureCode[];
export const VERIFICATION_FAILURE_ACTIONS: readonly TVerificationFailureAction[];
export function verificationUuid(value: unknown): value is string;
export function verificationSha256(value: unknown): value is string;
export function verificationObject(value: unknown): value is Record<string, unknown>;
export function verificationSafeText(value: unknown, max: number): value is string;
export function verificationExact(
    value: unknown,
    required: string[],
    optional?: string[],
): value is Record<string, unknown>;
export function verificationRelativePath(value: unknown): value is string;
export function verificationCheckCommand(value: unknown): IVerificationCheckCommand;
export function normalizeVerificationChecks(rows: unknown): IVerificationCheck[];
export function normalizeVerificationChanges(
    rows: unknown,
): Array<{ path: string; beforeSha256: string | null; afterSha256: string | null }>;
export function normalizeVerificationArtifacts(rows: unknown): Array<{ path: string; sha256: string }>;
export function assertVerificationOutcome(
    state: string,
    stage: string,
    checks: IVerificationCheck[],
    failure: { code: string; action: string } | undefined,
    codes: readonly string[],
    actions: readonly string[],
): void;
export function normalizeVerificationIntent(declared: unknown): IVerificationIntent;
export function verificationIntentDigest(intent: unknown): string;
export function normalizeVerificationResult(value: unknown, intent?: unknown): IVerificationResult;
export function assertAgentResultAccepted(value: unknown, failed: boolean, intent?: unknown): IVerificationResult;
