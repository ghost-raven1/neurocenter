export interface IChatContextMessage {
    role: string;
    content: string;
}
export interface IChatContextSettings {
    contextWindowTokens?: number | null;
    reservedOutputTokens?: number | null;
}
export interface IChatContext {
    contextWindowTokens: number | null;
    reservedOutputTokens: number | null;
    estimatedInputTokens: number;
    method: 'estimate';
    messageCount: number;
    maxMessageBytes: 131072;
    maxRequestBytes: 8388608;
    requestBytes: number;
    exceeded: boolean;
    canCompact: boolean;
    compactionNeeded: boolean;
    participants?: Array<{ agentId: string; name: string; modelId: string; modelName: string; context: IChatContext }>;
    reason?: string;
}
export interface IChatUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    reported: boolean;
}

const MAX_MESSAGE_BYTES = 131072,
    MAX_REQUEST_BYTES = 8388608;
const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const capacity = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

/** Explicit local allocation is sent as Ollama num_ctx; an unset allocation stays unknown. */
export function managedChatContextWindow(env: NodeJS.ProcessEnv = process.env): number | null {
    const value = env.MODEL_CHAT_CONTEXT_WINDOW_TOKENS;
    if (value === undefined || value === '') return null;
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 128 || parsed > 2097152)
        throw new Error('MODEL_CHAT_CONTEXT_WINDOW_TOKENS должен быть целым числом от 128 до 2097152.');
    return parsed;
}

/** Exact UTF-8 transport bounds plus an explicitly approximate, tokenizer-independent text estimate. */
export function chatContext(
    messages: readonly IChatContextMessage[],
    settings: IChatContextSettings = {},
): IChatContext {
    const contextWindowTokens = capacity(settings.contextWindowTokens),
        reservedOutputTokens = capacity(settings.reservedOutputTokens);
    const textBytes = messages.map((message) => Buffer.byteLength(message.content, 'utf8'));
    // Two bytes per token deliberately avoids the usual four-character shortcut for Cyrillic/code.
    // This remains a heuristic, including the message overhead; it cannot guarantee model-specific token counts.
    const estimatedInputTokens = messages.length
        ? Math.ceil(textBytes.reduce((sum, size) => sum + size, 0) / 2) + messages.length * 6 + 3
        : 0;
    const requestBytes = Buffer.byteLength(JSON.stringify({ messages, stream: false }), 'utf8');
    let reason: string | undefined;
    if (textBytes.some((size) => size > MAX_MESSAGE_BYTES))
        reason = 'Сообщение с содержимым файлов превышает предел 128 КиБ текста.';
    else if (requestBytes > MAX_REQUEST_BYTES)
        reason = 'Контекст превышает предел запроса 8 МиБ. Начните новый диалог.';
    else if (contextWindowTokens !== null && estimatedInputTokens + (reservedOutputTokens ?? 0) > contextWindowTokens) {
        reason =
            'Оценка контекста с резервом для ответа превышает настроенное окно модели. Уменьшите сообщение или начните новый диалог.';
    }
    return {
        contextWindowTokens,
        reservedOutputTokens,
        estimatedInputTokens,
        method: 'estimate',
        messageCount: messages.length,
        maxMessageBytes: MAX_MESSAGE_BYTES,
        maxRequestBytes: MAX_REQUEST_BYTES,
        requestBytes,
        exceeded: reason !== undefined,
        canCompact: false,
        compactionNeeded: false,
        ...(reason ? { reason } : {}),
    };
}

/** Missing provider usage stays unknown; a genuine reported zero remains zero. */
export function chatUsage(result: Record<string, unknown>): IChatUsage {
    const inputTokens = result.usage_reported === false ? null : count(result.prompt_eval_count);
    const outputTokens = result.usage_reported === false ? null : count(result.eval_count);
    const total = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
    return {
        inputTokens,
        outputTokens,
        totalTokens: total !== null && Number.isSafeInteger(total) ? total : null,
        reported: inputTokens !== null || outputTokens !== null,
    };
}
