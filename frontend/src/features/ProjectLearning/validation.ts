/** UI limits use the same UTF-8 byte boundary as the server, including Russian text and emoji. */
export function learningTextRule(limit: number) {
    return {validator: async (_: unknown, value: unknown): Promise<void> => {
        if (value === undefined || value === null || value === '') return;
        if (typeof value !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Текст содержит недопустимые символы.');
        const bytes = new TextEncoder().encode(value);
        if (new TextDecoder().decode(bytes) !== value) throw new Error('Текст содержит повреждённые символы Unicode.');
        if (bytes.byteLength > limit) throw new Error(`Допустимо до ${limit.toLocaleString('ru-RU')} байт UTF-8; сейчас ${bytes.byteLength.toLocaleString('ru-RU')}.`);
    }};
}
