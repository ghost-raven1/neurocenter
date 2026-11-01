import { responseAsJson } from './utils.js';
import { readCodexSession } from '../auth-session/auth-session.js';
import { CODEX_ENDPOINT, ALLOWED_REQUESTS } from './constants.js';
import type { TSessionReader } from './interfaces.js';

/** Use the supported Codex Responses endpoint while OpenCode retains its normal tools and approvals. */
export function createCodexFetch(
    readSession: TSessionReader = readCodexSession,
    transport: typeof fetch = fetch,
): typeof fetch {
    return async (input, init) => {
        const inputUrl = input instanceof Request ? input.url : String(input);

        if (!ALLOWED_REQUESTS.has(inputUrl)) {
            throw new Error('CodexBridge only authenticates the official Codex Responses endpoint');
        }

        const request = new Request(input, init);

        if (request.method !== 'POST') {
            throw new Error('CodexBridge only accepts Responses POST requests');
        }

        const body = (await request.json()) as Record<string, unknown>;
        const streaming = body.stream === true;
        body.stream = true;
        body.store = false;
        body.instructions ??= '';

        // ChatGPT's Codex transport controls these parameters; the API SDK otherwise emits API-only options.
        for (const field of [
            'max_output_tokens',
            'temperature',
            'top_p',
            'frequency_penalty',
            'presence_penalty',
            'truncation',
        ])
            delete body[field];

        const payload = JSON.stringify(body);

        for (let attempt = 0; attempt < 2; attempt++) {
            request.signal.throwIfAborted();
            const session = await readSession(attempt === 1, request.signal);
            const headers = new Headers(request.headers);

            headers.set('authorization', `Bearer ${session.accessToken}`);
            headers.set('ChatGPT-Account-Id', session.accountId);
            headers.set('originator', 'codexbridge');
            headers.set('content-type', 'application/json');
            headers.set('accept', 'text/event-stream');
            headers.delete('content-length');

            const response = await transport(CODEX_ENDPOINT, {
                method: 'POST',
                headers,
                body: payload,
                signal: request.signal,
                redirect: 'error',
            });

            if (response.status === 401 && attempt === 0) {
                await response.body?.cancel();
                continue;
            }

            if (!response.ok || streaming) {
                return response;
            }

            return responseAsJson(response);
        }
        throw new Error('Codex authentication failed after refresh');
    };
}
