import { describe, expect, it } from 'vitest';
import { observeCodexHttp, sanitizeCodexDiagnostic } from '../diagnostics.js';

describe('Codex diagnostic projection', () => {
    it('retains only stage-appropriate metadata and strips private content', () => {
        expect(
            sanitizeCodexDiagnostic({
                schemaVersion: 1,
                stage: 'preflight',
                httpStatus: 401,
                mediaType: 'json',
                token: 'private',
            }),
        ).toEqual({ schemaVersion: 1, stage: 'preflight' });
        expect(
            sanitizeCodexDiagnostic({
                schemaVersion: 1,
                stage: 'response-headers',
                httpStatus: 401,
                mediaType: 'json',
                body: 'private',
            }),
        ).toEqual({ schemaVersion: 1, stage: 'response-headers', httpStatus: 401, mediaType: 'json' });
        expect(sanitizeCodexDiagnostic({ schemaVersion: 1, stage: 'unrecognized' })).toBeUndefined();
    });

    it('observes media type without consuming the response body', async () => {
        const response = new Response('data: complete\n\n', {
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
        expect(observeCodexHttp(response)).toEqual({ httpStatus: 200, mediaType: 'sse' });
        expect(response.bodyUsed).toBe(false);
        expect(await response.text()).toBe('data: complete\n\n');
    });
});
