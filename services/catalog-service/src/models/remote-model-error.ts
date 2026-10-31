/** Sanitized inference failure; provider response bodies and credentials are never exposed. */
export class RemoteModelError extends Error {
    constructor(
        readonly kind: 'authorization' | 'rate-limit' | 'unavailable' | 'response',
        message: string,
    ) {
        super(message);
    }
}
