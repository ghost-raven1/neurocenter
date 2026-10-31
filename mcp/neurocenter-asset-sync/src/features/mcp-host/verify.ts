/** Wire envelope remains untrusted; the probe only inspects errors and the tools array. */
interface HostedMcpResponse {
    error?: unknown;
    result?: { tools?: unknown };
}

/** Установка подтверждает живой канал: initialize и tools/list по билету, без чтения ресурсов и calls. */
export async function verifyHostedMcpChannel(url: string, timeoutMs = 30000): Promise<number> {
    const request = async (
        body: unknown,
        sessionId?: string,
    ): Promise<{ parsed: HostedMcpResponse | null; sessionId?: string }> => {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
            },
            body: JSON.stringify(body),
            redirect: 'error',
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        const nextSession = response.headers.get('mcp-session-id') ?? undefined;
        if (response.status === 202 || text.trim() === '') {
            return { parsed: null, sessionId: nextSession };
        }
        if (!response.ok) {
            let message: unknown;
            try {
                message = (JSON.parse(text) as { error?: { message?: unknown } })?.error?.message;
            } catch {
                /* Не-JSON-ответ закрывается общим сообщением. */
            }
            throw new Error(
                typeof message === 'string' && message ? message : 'Хост MCP ответил ошибкой: ' + response.status,
            );
        }
        const trimmed = text.trim();
        const payloadText =
            trimmed.startsWith('{') || trimmed.startsWith('[')
                ? trimmed
                : (trimmed.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5).trim();
        if (!payloadText) {
            throw new Error('Хост MCP ответил пустым каналом.');
        }
        let parsed: HostedMcpResponse | null;
        try {
            parsed = JSON.parse(payloadText);
        } catch {
            throw new Error('Хост MCP ответил некорректным протоколом.');
        }
        return { parsed, sessionId: nextSession ?? undefined };
    };
    const initialized = await request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'neurocenter-bridge', version: '1' },
        },
    });
    if (initialized.parsed?.error) {
        throw new Error('Хост MCP не завершил инициализацию.');
    }
    const sessionId = initialized.sessionId;
    try {
        await request({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    } catch {
        /* Сервер без state может не ответить на уведомление. */
    }
    const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
    if (listed.parsed?.error) {
        throw new Error('Хост MCP не выдал список инструментов.');
    }
    const tools = Array.isArray(listed.parsed?.result?.tools) ? listed.parsed.result.tools.length : 0;
    if (tools < 0) {
        throw new Error('Хост MCP не отвечает.');
    }
    return tools;
}
