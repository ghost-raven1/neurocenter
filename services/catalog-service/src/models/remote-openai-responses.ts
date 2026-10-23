import { RemoteModelError } from './remote-model-error';
import type { IRemoteModelOptions } from './remote-model.types';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => { throw new RemoteModelError('response', 'Responses API не завершил текстовый ответ поддерживаемого формата.'); };

/** Convert validated OpenAI text/image messages without changing the selected model or options. */
export function openaiResponsesBody(model: string, messages: Json[], options: IRemoteModelOptions): Json {
    const input = messages.map(message => ({ role: message.role, content: typeof message.content === 'string'
        ? [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }]
        : (message.content as Json[]).map(part => part.type === 'text'
            ? { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
            : { type: 'input_image', image_url: (part.image_url as Json).url, detail: 'auto' }) }));
    return { model, input, stream: false,
        ...(options.store === undefined ? {} : { store: options.store }),
        ...(options.reasoningEffort === undefined ? {} : { reasoning: { effort: options.reasoningEffort } }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.topP === undefined ? {} : { top_p: options.topP }),
        ...(options.maxOutputTokens === undefined ? {} : { max_output_tokens: options.maxOutputTokens }) };
}

/** Only a terminal text response is accepted; refusals, tools, malformed and partial transports fail closed. */
export function openaiResponsesResult(value: Json): { content: string; reason: 'stop' | 'length'; inputTokens: unknown; outputTokens: unknown } {
    if (value.object !== 'response' || !['completed', 'incomplete'].includes(String(value.status))
        || value.status === 'incomplete' && (!object(value.incomplete_details) || value.incomplete_details.reason !== 'max_output_tokens')
        || !Array.isArray(value.output) || !value.output.length || value.output.length > 256) return fail();
    let content: string | undefined;
    for (const item of value.output) {
        if (!object(item)) return fail();
        if (item.type === 'reasoning') continue;
        if (item.type !== 'message' || item.role !== 'assistant' || !['completed', 'incomplete'].includes(String(item.status))
            || value.status === 'completed' && item.status !== 'completed' || content !== undefined
            || !Array.isArray(item.content) || !item.content.length || item.content.length > 256) return fail();
        const parts: string[] = [];
        for (const part of item.content) {
            if (!object(part) || part.type !== 'output_text' || typeof part.text !== 'string') return fail();
            parts.push(part.text);
        }
        content = parts.join('');
    }
    if (!content?.trim()) return fail();
    const usage = object(value.usage) ? value.usage : {};
    return { content, reason: value.status === 'completed' ? 'stop' : 'length', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}
