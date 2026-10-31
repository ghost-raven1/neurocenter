const unsafeWarnings = new Set([
    'invalid-json',
    'unsafe-path',
    'read-failed',
    'source-changed',
    'entry-limit',
    'ambiguous-config',
]);

/** Incomplete or ambiguous metadata cannot authorize provider use or agent compilation. */
export function hasUnsafeOpenCodeWarnings(warnings: readonly string[]): boolean {
    return warnings.some((warning) => unsafeWarnings.has(warning));
}
