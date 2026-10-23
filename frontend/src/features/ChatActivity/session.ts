let sessionId: string | undefined;
let sequence = 0;

/** Each document owns a distinct lease, including duplicated browser tabs. */
export function nextChatSession() {
    sessionId ??= crypto.randomUUID();
    return {sessionId, sequence: ++sequence};
}

/** Viewing and typing require a visible, focused browser window. */
export function chatWindowActive(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}
