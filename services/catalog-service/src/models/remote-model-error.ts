/** Sanitized inference failure; provider response bodies and credentials are never exposed. */
export class RemoteModelError extends Error {
    constructor(
        readonly kind: 'authorization' | 'rate-limit' | 'unavailable' | 'rejected' | 'response',
        message: string,
        readonly status?: number,
    ) {
        super(message);
    }
}
