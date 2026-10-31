/** Journaled actions and the bounded read-only CLI probe can stop after bridge admission. */
export function canCancelBridgeJob(kind: string, state: string): boolean {
    return (
        state === 'queued' ||
        ([
            'sync-learning-memory',
            'import-learning-quirks',
            'infer-device-codex',
            'inspect-opencode-cli',
            'install-opencode-cli',
            'inspect-opencode-global-providers',
            'open-opencode-global-providers',
        ].includes(kind) &&
            ['running', 'reconciling'].includes(state))
    );
}
