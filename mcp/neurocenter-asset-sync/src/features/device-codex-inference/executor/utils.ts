import type { DeviceCodexContext } from '../contract.js';

/** Normalize a validated Codex context into the supported Responses request. */
export function requestBody(context: DeviceCodexContext): Record<string, unknown> {
    if (
        Object.keys(context.options).some((key) => !['reasoningEffort', 'store'].includes(key)) ||
        (context.options.store !== undefined && context.options.store !== false)
    )
        throw new Error('Параметры запроса не поддерживаются Codex.');
    const instructions = context.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
    const input = context.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
            role: message.role,
            content: [
                { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content },
                ...(message.images ?? []).map((data) => ({
                    type: 'input_image',
                    image_url: imageUrl(data),
                    detail: 'auto',
                })),
            ],
        }));
    if (!input.length) throw new Error('Запрос Codex не содержит сообщения.');
    return {
        model: context.model,
        instructions,
        input,
        stream: true,
        store: false,
        ...(context.options.reasoningEffort ? { reasoning: { effort: context.options.reasoningEffort } } : {}),
    };
}
function imageUrl(data: string): string {
    const bytes = Buffer.from(data.slice(0, 32), 'base64');
    const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? 'jpeg'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
            ? 'webp'
            : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
              ? 'gif'
              : undefined;
    if (!format) throw new Error('Формат изображения не поддерживается Codex.');
    return 'data:image/' + format + ';base64,' + data;
}
