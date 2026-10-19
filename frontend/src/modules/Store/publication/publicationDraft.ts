import type { IAiPluginConfig, IAiPluginCreate, ISkillCreateRequest, ISkillResource, IDependencyPin } from '../../../core/api/interfaces';
import { checkDependencyPins } from './dependencyPins';
import { editMcpConfig } from '../storeEditHelpers';

export interface IPublicationFile { path: string; content: string; }
export interface IPublicationDraft {
    resources?: ISkillResource[];
    dependencies?: IDependencyPin[];
    kind: 'mcp' | 'plugin' | 'skill';
    name: string; description: string; tags?: string;
    slug?: string; instruction?: string;
    mode?: 'remote' | 'command' | 'bundle';
    url?: string; headers?: string; disableOAuth?: boolean;
    command?: string; args?: string; env?: string; entrypoint?: string;
}

function json(value: string | undefined, label: string, fallback: unknown): unknown {
    if (!value?.trim()) { return fallback; }
    try { return JSON.parse(value); } catch { throw new Error(`${label}: проверьте JSON. Строки и ключи должны быть в двойных кавычках.`); }
}

function map(value: unknown, label: string): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) { throw new Error(`${label}: нужен JSON-объект со строковыми значениями.`); }
    return value as Record<string, string>;
}

/** Одна проверка подключения используется полями формы и финальной публикацией. */
export function publicationMcpConfig(draft: IPublicationDraft): IAiPluginConfig {
    if (draft.mode === 'remote') {
        let url: URL;
        try { url = new URL(draft.url ?? ''); } catch { throw new Error('Укажите полный http:// или https:// адрес MCP.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) { throw new Error('URL MCP: только HTTP(S), без пароля и фрагмента.'); }
        return editMcpConfig(JSON.stringify({transport: 'remote', url: draft.url?.trim(), headers: map(json(draft.headers, 'Заголовки', {}), 'Заголовки'), ...(draft.disableOAuth ? {oauth: false as const} : {})}));
    }
    const bundled = draft.mode === 'bundle';
    const args = json(draft.args, 'Аргументы', []);
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) { throw new Error('Аргументы задаются JSON-массивом строк: ["--port", "3000"].'); }
    if (!bundled && !draft.command?.trim()) { throw new Error('Укажите программу для запуска MCP.'); }
    return editMcpConfig(JSON.stringify({transport: 'stdio', command: bundled ? 'node' : draft.command?.trim(), args,
        env: map(json(draft.env, 'Окружение', {}), 'Окружение'), ...(bundled ? {entrypoint: draft.entrypoint} : {})}));
}

export type TPublicationMcpField = 'url' | 'headers' | 'command' | 'args' | 'env';

/** Остальные поля не мешают показать ошибку именно у изменяемого значения. */
export function checkPublicationMcpField(field: TPublicationMcpField, value: string | undefined): void {
    publicationMcpConfig({kind: 'mcp', name: '', description: '', mode: field === 'url' || field === 'headers' ? 'remote' : 'command',
        url: 'https://example.invalid/mcp', command: 'node', [field]: value});
}

/** Разные типы публикации отправляют только собственные поля, без скрытых значений соседней вкладки. */
export function publicationPayload(draft: IPublicationDraft, files: IPublicationFile[]): IAiPluginCreate | ISkillCreateRequest {
    const name = draft.name?.trim();
    const description = draft.description?.trim();
    if (!name || !description) { throw new Error('Заполните название и описание инструмента.'); }
    const tags = [...new Set((draft.tags ?? '').split(',').map(tag => tag.trim()).filter(Boolean))];
    if (tags.length > 20 || tags.some(tag => tag.length > 40)) { throw new Error('Укажите до 20 тегов, не длиннее 40 символов каждый.'); }
    const dependencies = draft.dependencies !== undefined ? checkDependencyPins(draft.dependencies) : undefined;
    if (draft.kind === 'skill') {
        if (!draft.slug || draft.slug.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(draft.slug)) { throw new Error('Идентификатор скилла: до 64 строчных латинских букв, цифр и одиночных дефисов.'); }
        if (!draft.instruction?.trim()) { throw new Error('Добавьте инструкцию скилла.'); }
        return { path: 'common', slug: draft.slug, name, body: draft.instruction, ...(draft.resources?.length ? {resources: draft.resources} : {}), meta: { description, tags, mcp: [], plugins: [], ...(dependencies !== undefined ? {dependencies} : {}) } };
    }
    if (draft.kind === 'mcp' && draft.mode !== 'remote' && draft.mode !== 'bundle') {
        throw new Error('Локальный MCP требует закреплённого пакета. Используйте «Упаковать инструмент» или добавьте JS-файлы с точкой входа.');
    }
    const body: IAiPluginCreate = {name, description, tags, kind: draft.kind, origin: 'store-manual', ...(dependencies !== undefined ? {dependencies} : {})};
    const bundled = draft.kind === 'plugin' || draft.mode === 'bundle';
    if (bundled) {
        if (!files.length || files.some(file => !file.path.trim())) { throw new Error('Заполните путь каждого файла или удалите незаполненную строку.'); }
        if (!draft.entrypoint || !files.some(file => file.path === draft.entrypoint && file.content.trim())) { throw new Error('Укажите непустой файл запуска из добавленных файлов.'); }
        const used = new Set<string>();
        let bytes = 0;
        for (const file of files) {
            const key = file.path.toLowerCase();
            if (used.has(key)) { throw new Error(`Файл «${file.path}» добавлен несколько раз, включая разный регистр букв.`); }
            used.add(key);
            const size = new TextEncoder().encode(file.content).length;
            bytes += size;
            if (size > 1024 * 1024 || bytes > 5 * 1024 * 1024) { throw new Error('Лимит: 1 МиБ на файл и 5 МиБ на пакет.'); }
        }
        body.files = files.map(file => ({...file, size: new TextEncoder().encode(file.content).length, digest: ''}));
    }
    if (draft.kind === 'plugin') { body.config = {entrypoint: draft.entrypoint}; return body; }
    body.config = publicationMcpConfig(draft);
    return body;
}

/** Ключ остаётся прежним при сетевом повторе неизменённой публикации. */
export function newPublicationKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}
