import { request } from 'node:http';
/** Direct loopback HTTP bypasses environment proxies; responses, redirects and errors are never echoed. */
export async function accountRequest(
    url: URL,
    password: string,
    maximum: number,
    signal?: AbortSignal,
    body?: unknown,
): Promise<unknown> {
    const timeout = AbortSignal.timeout(10000);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise((resolve, reject) => {
        const fail = () => reject(Error('OpenCode account request failed.'));
        const req = request(
            url,
            {
                method: body === undefined ? 'GET' : 'POST',
                signal: bounded,
                agent: false,
                headers: {
                    Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
            },
            (response) => {
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    response.destroy();
                    fail();
                    return;
                }
                let bytes = 0;
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > maximum) {
                        response.destroy();
                        fail();
                    } else chunks.push(chunk);
                });
                response.on('error', fail);
                response.on('aborted', fail);
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        fail();
                    }
                });
            },
        );
        req.on('error', fail);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}
