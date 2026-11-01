/** Consume a streamed Responses reply for SDK doGenerate callers (for example session titles). */
export async function responseAsJson(response: Response): Promise<Response> {
    if (!response.body) {
        throw new Error('Codex returned an empty response');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '',
        bytes = 0;

    try {
        while (true) {
            const part = await reader.read();

            if (part.done) {
                break;
            }

            bytes += part.value.byteLength;

            if (bytes > 16 * 1024 * 1024) {
                throw new Error('Codex response exceeds 16 MiB');
            }

            buffer += decoder.decode(part.value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');

            let end: number;

            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const event = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = event
                    .split('\n')
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trimStart())
                    .join('\n');

                if (!data || data === '[DONE]') {
                    continue;
                }

                const parsed = JSON.parse(data);

                if (parsed.type === 'response.completed' || parsed.type === 'response.incomplete') {
                    return new Response(JSON.stringify(parsed.response), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }

                if (parsed.type === 'response.failed' || parsed.type === 'error') {
                    throw new Error('Codex response failed');
                }
            }
        }
        throw new Error('Codex stream ended before its final response');
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}
