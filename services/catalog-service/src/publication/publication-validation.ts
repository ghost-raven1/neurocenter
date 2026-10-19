import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

import type { IAiPluginConfig, IAiPluginCreate, IAiPluginFile } from '../catalog/dto';
import { publicationRuntimeExtra, validateArtifactLaunchFields } from './publication-runtime';
import { normalizeRuntimeArtifacts, portablePath } from '../../../shared/runtime-artifacts.cjs';
import { isSourceEntrypoint } from '../../../shared/source-entrypoint.cjs';
import { normalizeDependencyPins } from '../../../shared/dependency-pins.cjs';

export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const secretKey = /(?:token|secret|password|api[-_]?key|authorization|cookie)/i;
const envReference = /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
const authorizationReference = /^(?:Bearer|Basic) \{env:[A-Za-z_][A-Za-z0-9_]*\}$/i;
const forbiddenKey = new Set(['__proto__', 'prototype', 'constructor']);

/** Проверяет структуру JSON до сохранения в общий каталог. */
export function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(`${label}: ожидается JSON-объект.`);
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit: number, required = true): string {
    if (typeof value !== 'string' || value.includes('\0')) { throw new BadRequestException(`${label}: ожидается текст.`); }
    const result = value.trim().normalize('NFC');
    if ((required && !result) || result.length > limit) { throw new BadRequestException(`${label}: от ${required ? 1 : 0} до ${limit} символов.`); }
    return result;
}

/** Пути остаются одинаковыми на Windows, macOS и Linux; исправлять опасный путь молча нельзя. */
export function filePath(value: unknown): string {
    if (typeof value !== 'string') {throw new BadRequestException('Путь файла: ожидается текст.');}
    if (value.trim() !== value || !portablePath(value) || value.split('/').some(part =>
        ['.git', '.env', '.npmrc', '.yarnrc', '.yarnrc.yml', 'node_modules'].includes(part.toLowerCase())
        || part.toLowerCase().startsWith('.env.') && part.toLowerCase() !== '.env.example')) {
        throw new BadRequestException(`Недопустимый путь файла «${String(value)}». Используйте относительный путь через /. `);
    }
    return value;
}

/** Размеры и хэши вычисляются по UTF-8 на сервере, а не принимаются от клиента. */
export function packageFiles(value: unknown): IAiPluginFile[] {
    if (!Array.isArray(value) || value.length > 100) { throw new BadRequestException('Допустимо до 100 текстовых файлов.'); }
    const paths = new Set<string>();
    let bytes = 0;
    return value.map(raw => {
        const file = object(raw, 'Файл');
        const path = filePath(file.path);
        const key = path.normalize('NFC').toLowerCase();
        const ancestors = key.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
        if (paths.has(key) || ancestors.some(parent => paths.has(parent)) || [...paths].some(other => other.startsWith(`${key}/`))) {
            throw new BadRequestException(`Файлы конфликтуют по пути «${path}», включая регистр букв.`);
        }
        paths.add(key);
        if (typeof file.content !== 'string' || file.content.includes('\0')) { throw new BadRequestException(`«${path}»: требуется текст UTF-8, бинарные файлы пока не поддерживаются.`); }
        const size = Buffer.byteLength(file.content, 'utf8');
        bytes += size;
        if (size > MAX_FILE_BYTES || bytes > MAX_PACKAGE_BYTES) { throw new BadRequestException('Лимит: 1 МиБ на файл и 5 МиБ на пакет.'); }
        return { path, content: file.content, size, digest: createHash('sha256').update(file.content, 'utf8').digest('hex') };
    });
}

function stringMap(value: unknown, label: string, headers = false): Record<string, string> {
    const entries = Object.entries(object(value, label));
    if (entries.length > 50) { throw new BadRequestException(`${label}: не более 50 значений.`); }
    const names = new Set<string>();
    return Object.fromEntries(entries.map(([key, raw]) => {
        const valid = headers ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
        if (!valid || forbiddenKey.has(key) || names.has(key.toLowerCase()) || typeof raw !== 'string' || raw.length > 4096 || /[\x00\r\n]/.test(raw)) {
            throw new BadRequestException(`${label}: проверьте имена и строковые значения.`);
        }
        names.add(key.toLowerCase());
        const secretTemplate = envReference.test(raw) || headers && key.toLowerCase() === 'authorization' && authorizationReference.test(raw);
        if ((secretKey.test(key) || headers && !['accept', 'content-type'].includes(key.toLowerCase())) && !secretTemplate) {
            throw new BadRequestException(`${label}: секрет «${key}» замените ссылкой {env:ИМЯ_ПЕРЕМЕННОЙ}. Общий каталог виден командам.`);
        }
        return [key, raw];
    }));
}

/** Нормализует только поддерживаемые настройки MCP; неизвестные поля не теряются молча. */
export function mcpConfig(value: unknown, files: IAiPluginFile[]): IAiPluginConfig {
    const source = object(value, 'Настройки MCP');
    const allowed = ['transport', 'command', 'args', 'env', 'url', 'headers', 'oauth', 'entrypoint', 'extra'];
    if (Object.keys(source).some(key => !allowed.includes(key))) { throw new BadRequestException('В настройках MCP есть неподдерживаемые поля.'); }
    const extra = publicationRuntimeExtra(source.extra, 'mcp', source.transport);
    const artifacts = normalizeRuntimeArtifacts(extra?.runtimeArtifacts);
    if (source.transport === 'remote') {
        if (files.length || ['command', 'args', 'env', 'entrypoint'].some(key => source[key] !== undefined)) { throw new BadRequestException('Удалённый MCP задаётся URL и заголовками, без локальных файлов и команды.'); }
        const url = text(source.url, 'URL MCP', 2048);
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new BadRequestException('Укажите полный http:// или https:// URL MCP.'); }
        if (/[\x00-\x1f\x7f]/.test(url) || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash
            || [...parsed.searchParams.keys()].some(key => secretKey.test(key))) { throw new BadRequestException('URL MCP должен быть HTTP(S), без пароля, токена и фрагмента.'); }
        if (source.oauth !== undefined && source.oauth !== false) { throw new BadRequestException('Поддерживается автоматический OAuth или oauth: false. Регистрация собственного OAuth-клиента пока недоступна.'); }
        return { transport: 'remote', url, ...(source.headers !== undefined ? {headers: stringMap(source.headers, 'Заголовки', true)} : {}), ...(source.oauth === false ? {oauth: false as const} : {}), ...(extra ? {extra} : {}) };
    }
    if (source.transport !== 'stdio' || ['url', 'headers', 'oauth'].some(key => source[key] !== undefined)) { throw new BadRequestException('Выберите локальный или удалённый MCP и заполните соответствующие настройки.'); }
    const command = artifacts.length && source.command === undefined ? undefined : text(source.command, 'Команда', 500);
    if (command !== undefined && /[\x00-\x1f\x7f]/.test(command)) { throw new BadRequestException('Команда должна содержать путь к программе без переноса строки.'); }
    if (source.args !== undefined && (!Array.isArray(source.args) || source.args.length > 64 || source.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')))) {
        throw new BadRequestException('Аргументы: JSON-массив строк. Пробелы внутри аргумента сохраняются.');
    }
    const result: IAiPluginConfig = { transport: 'stdio', ...(command !== undefined ? {command} : {}), args: source.args as string[] ?? [], ...(extra ? {extra} : {}) };
    if (source.env !== undefined) { result.env = stringMap(source.env, 'Окружение'); }
    if (!artifacts.length && !files.length) {
        throw new BadRequestException('Локальный MCP требует закреплённого пакета. Используйте «Упаковать инструмент» для npm, репозитория или готового runtime, либо добавьте JS-файлы с точкой входа.');
    }
    if (artifacts.length) {
        validateArtifactLaunchFields(source, artifacts, true);
        if (source.entrypoint !== undefined) { result.entrypoint = source.entrypoint as string; }
    } else if (files.length) {
        const entrypoint = filePath(source.entrypoint);
        if (command !== 'node' || !/\.(?:m?js|cjs)$/.test(entrypoint) || !files.some(file => file.path === entrypoint && file.content?.trim())) {
            throw new BadRequestException('Для текстового MCP-пакета укажите команду node и непустой .js/.mjs/.cjs файл запуска из пакета.');
        }
        result.entrypoint = entrypoint;
    }
    return result;
}

/** Общий контракт ручной публикации и повторной отправки запроса. */
export function validatePublication(raw: unknown): IAiPluginCreate {
    const body = object(raw, 'Публикация');
    const allowed = ['name', 'kind', 'description', 'version', 'compatibility', 'tags', 'origin', 'revision', 'config', 'files', 'publicationKey', 'dependencies'];
    if (Object.keys(body).some(key => !allowed.includes(key))) { throw new BadRequestException('В публикации есть неподдерживаемые поля.'); }
    if (!['mcp', 'plugin'].includes(String(body.kind))) { throw new BadRequestException('Выберите тип инструмента: MCP или плагин.'); }
    const name = text(body.name, 'Название', 128);
    if (/^ai-plug-/i.test(name)) { throw new BadRequestException('Префикс ai-plug- зарезервирован для ID инструмента.'); }
    if (/[\x00-\x1f\x7f/\\]/.test(name) || forbiddenKey.has(name)) { throw new BadRequestException('Название содержит недопустимые символы.'); }
    const description = text(body.description, 'Описание', 2000);
    if (body.version !== undefined && body.version !== 1) { throw new BadRequestException('Первая версия равна 1. Новую версию создавайте через редактирование.'); }
    if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 20)) { throw new BadRequestException('Укажите до 20 тегов.'); }
    const tags = [...new Set((body.tags as unknown[] ?? []).map(tag => text(tag, 'Тег', 40)))];
    let dependencies: ReturnType<typeof normalizeDependencyPins>;
    try { dependencies = normalizeDependencyPins(body.dependencies); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    const files = packageFiles(body.files ?? []);
    let config: IAiPluginConfig | null;
    if (body.kind === 'mcp') { config = mcpConfig(body.config, files); }
    else {
        const source = object(body.config, 'Файл запуска плагина');
        if (Object.keys(source).some(key => !['entrypoint', 'extra'].includes(key))) { throw new BadRequestException('У плагина поддерживаются entrypoint и декларация готового комплекта.'); }
        const extra = publicationRuntimeExtra(source.extra, 'plugin');
        const artifacts = normalizeRuntimeArtifacts(extra?.runtimeArtifacts);
        if (artifacts.length) {
            validateArtifactLaunchFields(source, artifacts);
            config = { ...(source.entrypoint !== undefined ? {entrypoint: source.entrypoint as string} : {}), ...(extra ? {extra} : {}) };
        } else {
            if (!files.length) { throw new BadRequestException('Добавьте файлы плагина или готовый платформенный комплект. Имя npm-пакета без файлов пока не поддерживается.'); }
            const entrypoint = filePath(source.entrypoint);
            if (!/\.(?:m?js|cjs|ts)$/.test(entrypoint) || !isSourceEntrypoint(entrypoint) || !files.some(file => file.path === entrypoint && file.content?.trim())) { throw new BadRequestException('Укажите непустой JS/TS-файл запуска из файлов плагина, без деклараций типов.'); }
            config = { entrypoint, ...(extra ? {extra} : {}) };
        }
    }
    const publicationKey = body.publicationKey === undefined ? undefined : text(body.publicationKey, 'Ключ публикации', 36);
    if (publicationKey !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicationKey)) { throw new BadRequestException('Некорректный ключ публикации.'); }
    return { name, kind: body.kind as 'mcp' | 'plugin', description, tags, files, config, version: 1,
        origin: body.origin === undefined ? 'upload' : text(body.origin, 'Источник', 256),
        compatibility: body.compatibility == null ? undefined : text(body.compatibility, 'Совместимость', 200, false),
        revision: body.revision == null ? null : text(body.revision, 'Ревизия', 200, false), publicationKey,
        ...(dependencies.length ? { dependencies } : {}) };
}

/** Порядок ключей JSON не меняет идентичность повторной публикации. */
export function publicationHash(value: unknown): string {
    const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
        : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : input;
    return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}
