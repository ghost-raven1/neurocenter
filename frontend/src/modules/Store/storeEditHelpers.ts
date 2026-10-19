import type { IAiPlugin, IAiPluginConfig, IAiPluginUpdate, ISkillFile, ISkillUpdateRequest, ISkillResource, IDependencyPin } from '../../core/api/interfaces';
import { checkDependencyPins } from './publication/dependencyPins';
import { editMcpExtra } from './storeMcpExtra';

export interface IStoreEditValues {
    resources?: ISkillResource[];
    dependencies?: IDependencyPin[];
    clearLegacyRequirements?: boolean;
    name: string;
    description: string;
    tags: string;
    body: string;
    config: string;
}

export interface IStoreEditFailure { message: string; status?: number; }

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const secretKey = /(?:token|secret|password|api[-_]?key|authorization|cookie)/i;
const envReference = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const authorizationReference = /^(?:Bearer|Basic) \{env:[A-Za-z_][A-Za-z0-9_]*\}$/i;

/** Теги нормализуются без потери русских названий и порядка. */
export function editTags(value: string, limit = 40): string[] {
    const tags = [...new Set(value.split(',').map(tag => tag.trim().normalize('NFC')).filter(Boolean))];
    if (tags.length > 20 || tags.some(tag => tag.length > limit || /[\x00-\x1f\x7f]/.test(tag))) {
        throw new Error(`Укажите до 20 тегов, не длиннее ${limit} символов каждый.`);
    }
    return tags;
}

/** Проверка JSON перед отправкой: строки аргументов и ссылки на секреты остаются точными. */
export function editMcpConfig(value: string): IAiPluginConfig {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error('Проверьте JSON: нужны двойные кавычки, без комментариев и лишних запятых.'); }
    if (!isObject(parsed)) { throw new Error('Настройки MCP должны быть JSON-объектом.'); }
    const allowed = ['transport', 'command', 'args', 'env', 'url', 'headers', 'oauth', 'entrypoint', 'extra'];
    if (Object.keys(parsed).some(key => !allowed.includes(key))) { throw new Error('Поддерживаются поля transport, command, args, env, url, headers, oauth, entrypoint и extra.'); }
    if (!['stdio', 'remote'].includes(String(parsed.transport))) { throw new Error('Укажите transport: "stdio" или "remote".'); }
    const artifacts = editMcpExtra(parsed);
    if (parsed.transport === 'remote') {
        if (['command', 'args', 'env', 'entrypoint'].some(key => parsed[key] !== undefined)) { throw new Error('У удалённого MCP используются URL и заголовки, без локальной команды.'); }
        let url: URL;
        try { url = new URL(typeof parsed.url === 'string' ? parsed.url : ''); } catch { throw new Error('Укажите полный http:// или https:// URL MCP.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => secretKey.test(key))) {
            throw new Error('URL MCP должен быть HTTP(S), без пароля, токена и фрагмента.');
        }
        if (parsed.oauth !== undefined && parsed.oauth !== false) { throw new Error('OAuth определяется автоматически; для отключения используйте oauth: false.'); }
    } else {
        if ((!artifacts || parsed.command !== undefined) && (typeof parsed.command !== 'string' || !parsed.command.trim() || parsed.command.length > 500 || /[\x00-\x1f\x7f]/.test(parsed.command))) { throw new Error('Укажите команду запуска без переноса строки.'); }
        if (['url', 'headers', 'oauth'].some(key => parsed[key] !== undefined)) { throw new Error('Для MCP-сервера используются команда, аргументы и окружение, без URL.'); }
        if (parsed.args !== undefined && (!Array.isArray(parsed.args) || parsed.args.length > 64 || parsed.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')))) {
            throw new Error('Аргументы args задаются JSON-массивом строк: пробелы внутри аргумента сохраняются.');
        }
        if (parsed.entrypoint !== undefined && (typeof parsed.entrypoint !== 'string' || !parsed.entrypoint)) { throw new Error('entrypoint должен содержать путь к файлу запуска.'); }
    }
    for (const field of ['env', 'headers']) {
        const map = parsed[field];
        if (map === undefined) { continue; }
        if (!isObject(map) || Object.keys(map).length > 50) { throw new Error(`${field}: ожидается объект, не более 50 строковых значений.`); }
        const keys = new Set<string>();
        for (const [key, entry] of Object.entries(map)) {
            const valid = field === 'headers' ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
            if (!valid || ['__proto__', 'constructor', 'prototype'].includes(key) || keys.has(key.toLowerCase()) || typeof entry !== 'string' || entry.length > 4096 || /[\x00\r\n]/.test(entry)) {
                throw new Error(`${field}: проверьте имена и строковые значения.`);
            }
            keys.add(key.toLowerCase());
            const secretTemplate = envReference.test(entry) || field === 'headers' && key.toLowerCase() === 'authorization' && authorizationReference.test(entry);
            if ((secretKey.test(key) || field === 'headers' && !['accept', 'content-type'].includes(key.toLowerCase())) && !secretTemplate) {
                throw new Error(`${key}: замените секрет ссылкой {env:ИМЯ_ПЕРЕМЕННОЙ}, например {env:API_KEY}.`);
            }
        }
    }
    return parsed as unknown as IAiPluginConfig;
}

/** Отправляет только редактируемые поля и версию открытой копии, без служебных метаданных. */
export function skillEditPayload(skill: ISkillFile, values: IStoreEditValues): ISkillUpdateRequest & { expectedVersion: number } {
    return { name: values.name.trim().normalize('NFC'), body: values.body, ...(values.resources !== undefined ? {resources: values.resources} : {}), meta: { description: values.description.trim(), tags: editTags(values.tags, 128),
        ...(values.dependencies !== undefined ? {dependencies: checkDependencyPins(values.dependencies)} : {}),
        ...(values.clearLegacyRequirements ? {mcp: [], plugins: []} : {}) }, expectedVersion: skill.meta.version };
}

/** Отсутствующее поле старого черновика сохраняет зависимости, пустой массив явно удаляет их. */
export function pluginEditPayload(plugin: IAiPlugin, values: IStoreEditValues): IAiPluginUpdate {
    return {description: values.description.trim(), tags: editTags(values.tags), expectedVersion: plugin.version,
        ...(plugin.kind === 'mcp' ? {config: editMcpConfig(values.config)} : {}),
        ...(values.dependencies !== undefined ? {dependencies: checkDependencyPins(values.dependencies)} : {})};
}

/** Возврат к исходному составу зависимостей снимает признак несохранённых изменений. */
export function storeEditValuesChanged(initial: IStoreEditValues, current: IStoreEditValues): boolean {
    return Object.keys(current).some(raw => {
        const key = raw as keyof IStoreEditValues;
        if (key === 'dependencies') { return JSON.stringify(current.dependencies ?? []) !== JSON.stringify(initial.dependencies ?? []); }
        if (key === 'clearLegacyRequirements') { return Boolean(current[key]) !== Boolean(initial[key]); }
        return JSON.stringify(current[key]) !== JSON.stringify(initial[key]);
    });
}

/** Серверное объяснение сохраняется в форме; сетевой отказ не стирает черновик. */
export function storeEditFailure(error: unknown, fallback: string): IStoreEditFailure {
    const response = isObject(error) && isObject(error.response) ? error.response : undefined;
    const status = response && typeof response.status === 'number' ? response.status : undefined;
    const data = response && isObject(response.data) ? response.data : undefined;
    const raw = data?.message;
    const detail = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').join(' ') : '';
    if (status === 409) { return { status, message: `${detail || 'Изменение конфликтует с состоянием сервера. Проверьте актуальную копию перед повторным сохранением.'} Ваши правки остались в форме.` }; }
    if (status === 403) { return { status, message: detail || 'Доступ к редактированию отозван. Ваши правки остались в форме: их можно скопировать.' }; }
    if (status === 404) { return { status, message: detail || 'Инструмент удалён или больше недоступен. Ваши правки остались в форме.' }; }
    if (detail) { return { status, message: detail }; }
    if (error instanceof Error && !('isAxiosError' in error)) { return { status, message: error.message }; }
    return { status, message: fallback };
}
