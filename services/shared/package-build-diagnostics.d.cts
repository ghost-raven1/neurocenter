export interface IBuildDiagnostic {
    schemaVersion: 1;
    stage: 'inspect' | 'download' | 'dependencies' | 'compile' | 'pack' | 'build';
    target: string | null;
    code: string;
    reason: string;
    repairable: boolean;
}
export function cleanBuildReason(value: unknown): string;
export function parseBuildDiagnostic(value: unknown, targets: readonly string[]): IBuildDiagnostic | undefined;
export function withBuildDiagnostic<T>(
    stage: IBuildDiagnostic['stage'],
    target: string | null,
    work: () => Promise<T>,
): Promise<T>;
