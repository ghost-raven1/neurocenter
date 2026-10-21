export const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_FILE_MAX_COUNT = 5;
export const CHAT_FILE_ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.css,.scss,.less,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.java,.kt,.go,.rs,.c,.h,.cpp,.hpp,.cs,.rb,.php,.swift,.sh,.bash,.zsh,.sql,.toml,.ini,.log,.r,.lua,.vue,.svelte,.graphql,.gql,.properties,.conf,.cfg';
const extensions = new Set(CHAT_FILE_ACCEPT.split(','));

/** Browser checks improve feedback; the server independently inspects every uploaded document. */
export function chatFileError(file: Pick<File, 'name' | 'size'>): string {
    if (!file.name || !file.size) return 'Пустой файл нельзя прикрепить.';
    if (file.size > CHAT_FILE_MAX_BYTES) return 'Максимальный размер одного файла — 10 МиБ.';
    const name = file.name.toLowerCase(), extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    if (!extensions.has(extension) && !['dockerfile', 'makefile', '.gitignore', '.editorconfig'].includes(name)) return 'Поддерживаются PDF, DOCX, текст, Markdown, CSV и исходный код. Изображения и OCR пока недоступны.';
    return '';
}

export function chatFileSize(value: number): string {
    if (value < 1024) return `${value} Б`;
    if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} КиБ`;
    return `${(value / 1024 / 1024).toFixed(1)} МиБ`;
}

/** Bounded files are encoded only for the private Gateway upload, never in message history. */
export function chatFileBase64(file: File, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const aborted = (): void => { reader.abort(); reject(new DOMException('Загрузка отменена', 'AbortError')); };
        const cleanup = (): void => signal.removeEventListener('abort', aborted);
        reader.onload = () => { cleanup(); const value = reader.result; if (typeof value !== 'string' || !value.includes(',')) reject(new Error('Не удалось прочитать файл.')); else resolve(value.slice(value.indexOf(',') + 1)); };
        reader.onerror = () => { cleanup(); reject(new Error('Не удалось прочитать файл. Выберите его снова.')); };
        reader.onabort = () => { cleanup(); reject(new DOMException('Загрузка отменена', 'AbortError')); };
        if (signal.aborted) { aborted(); return; }
        signal.addEventListener('abort', aborted, { once: true }); reader.readAsDataURL(file);
    });
}
