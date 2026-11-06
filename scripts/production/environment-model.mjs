import { readFile } from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const MODEL_FILE = 'deploy/production/environment-model.json';
export const MODEL_SCHEMA = 'neurocenter-environment-model-v1';
export const RUNTIME_SECRET_NAMES_FILE = 'services/shared/runtime.cjs';
export const SHARED_CODE_ROOT = 'services/shared';

const CODE_FILE_EXTENSIONS = new Set(['.ts', '.cts', '.mts', '.js', '.mjs', '.cjs']);
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'integration']);
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const CODE_ROOT_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Поля сервисной модели, которые drift-тест сверяет с compose. */
export const SERVICE_FIELDS = [
    'image',
    'networks',
    'networkMode',
    'memLimit',
    'cpus',
    'pidsLimit',
    'readOnly',
    'capDrop',
    'capAdd',
    'seccomp',
    'secrets',
    'ports',
    'volumes',
    'env',
];

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Разрешает Compose merge-ключи (`<<: *anchor`) до сравнения с моделью. */
export function resolveMergeKeys(node) {
    if (Array.isArray(node)) return node.map(resolveMergeKeys);
    if (!isMap(node)) return node;
    if (!Object.hasOwn(node, '<<')) {
        for (const key of Object.keys(node)) node[key] = resolveMergeKeys(node[key]);
        return node;
    }
    const bases = node['<<'];
    const resolved = {};
    for (const base of Array.isArray(bases) ? bases : [bases]) {
        const flat = resolveMergeKeys(base);
        if (!isMap(flat)) throw new Error('Compose merge-ключь указывает не на отображение');
        for (const [key, value] of Object.entries(flat)) resolved[key] = value;
    }
    for (const [key, value] of Object.entries(node)) {
        if (key !== '<<') resolved[key] = resolveMergeKeys(value);
    }
    return resolved;
}

/** Наложение overlay-файла на базовый документ Compose (env объединяется, списки портов/секретов растут). */
export function mergeComposeDocuments(base, overlay) {
    const merged = structuredClone(base);
    for (const [key, value] of Object.entries(overlay)) {
        if (key === 'services' && isMap(value)) {
            merged.services = { ...(merged.services ?? {}) };
            for (const [name, service] of Object.entries(value)) {
                merged.services[name] = mergeService(merged.services[name] ?? {}, service);
            }
        } else if (key === 'secrets' || key === 'networks' || key === 'volumes') {
            merged[key] = { ...(merged[key] ?? {}), ...value };
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function mergeService(base, overlay) {
    const merged = structuredClone(base);
    for (const [key, value] of Object.entries(overlay)) {
        if (key === 'environment' && isMap(value)) {
            merged.environment = { ...(merged.environment ?? {}), ...value };
        } else if (['ports', 'secrets'].includes(key) && Array.isArray(value)) {
            merged[key] = [...(Array.isArray(merged[key]) ? merged[key] : []), ...value];
        } else {
            merged[key] = structuredClone(value);
        }
    }
    return merged;
}

function text(value) {
    return value === undefined || value === null ? null : String(value);
}

/** `80:8080`, `127.0.0.1:80:8080` или длинный вид → канонический объект порта. */
function normalizePort(port) {
    if (typeof port === 'string') {
        const parts = port.split(':');
        return {
            target: toNumber(parts[parts.length - 1]),
            published: parts.length > 1 ? toNumber(parts[parts.length - 2]) : null,
            hostIp: parts.length > 2 ? parts[0] : null,
            protocol: null,
        };
    }
    return {
        target: toNumber(port.target),
        published: port.published !== undefined && port.published !== null ? toNumber(port.published) : null,
        hostIp: port.host_ip ?? null,
        protocol: port.protocol ?? null,
    };
}

function toNumber(value) {
    return /^-?\d+$/.test(String(value)) ? Number(value) : String(value);
}

function normalizeEnvironment(environment) {
    if (!environment) return {};
    const resolved = {};
    if (Array.isArray(environment)) {
        for (const item of environment) {
            const separator = String(item).indexOf('=');
            if (separator < 0) throw new Error('Некорректный элемент env в Compose: ' + item);
            resolved[String(item).slice(0, separator)] = String(item).slice(separator + 1);
        }
        return resolved;
    }
    for (const [name, value] of Object.entries(environment)) {
        if (!ENV_NAME_PATTERN.test(name)) throw new Error('Некорректное имя env в Compose: ' + name);
        resolved[name] = value === null ? '' : String(value);
    }
    return resolved;
}

function normalizeNetworks(service) {
    if (service.network_mode !== undefined) return [];
    if (!service.networks) return [];
    if (Array.isArray(service.networks)) return service.networks.map(String);
    return Object.keys(service.networks);
}

function findSeccomp(securityOpt) {
    if (!Array.isArray(securityOpt)) return null;
    for (const option of securityOpt) {
        if (typeof option === 'string' && option.startsWith('seccomp:')) return option.slice('seccomp:'.length);
    }
    return null;
}

/** Каноническое представление одного Compose-сервиса для сверки с моделью. */
export function normalizeService(service) {
    return {
        image: text(service.image),
        networks: normalizeNetworks(service),
        networkMode: text(service.network_mode),
        memLimit: text(service.mem_limit),
        cpus: service.cpus ?? null,
        pidsLimit: service.pids_limit ?? null,
        readOnly: service.read_only === true,
        capDrop: Array.isArray(service.cap_drop) ? [...service.cap_drop].sort() : null,
        capAdd: Array.isArray(service.cap_add) ? [...service.cap_add].sort() : null,
        seccomp: findSeccomp(service.security_opt),
        secrets: Array.isArray(service.secrets) ? [...service.secrets].sort() : [],
        ports: (service.ports ?? [])
            .map(normalizePort)
            .sort((a, b) => String(a.target).localeCompare(String(b.target))),
        volumes: Array.isArray(service.volumes) ? service.volumes.map(String).sort() : [],
        env: normalizeEnvironment(service.environment),
        command: Array.isArray(service.command) ? service.command.join(' ') : (text(service.command) ?? ''),
    };
}

/** Разбирает YAML-документ Compose (merge-ключи разрешены). */
export function parseComposeDocument(content) {
    const document = loadYaml(content);
    if (!isMap(document) || !isMap(document.services)) throw new Error('Ожидался Compose-документ с services');
    return resolveMergeKeys(document);
}

/** Развёрнутые сервисы из одного или нескольких Compose-документов (base + overlay'и). */
export function normalizeServices(documents) {
    const merged = documents.reduce(mergeComposeDocuments);
    const services = {};
    for (const [name, service] of Object.entries(merged.services ?? {})) services[name] = normalizeService(service);
    return services;
}

function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
    }
    if (isMap(a) && isMap(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) {
            if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key) || !deepEqual(a[key], b[key])) return false;
        }
        return true;
    }
    return false;
}

/** Статическая валидация структуры модели до сверки с compose. */
export function validateModelShape(model) {
    if (!isMap(model) || model.schema !== MODEL_SCHEMA) {
        throw new Error('Некорректная модель окружения: поле schema = ' + MODEL_SCHEMA);
    }
    if (!isMap(model.compose) || typeof model.compose.base !== 'string' || !Array.isArray(model.compose.overlays)) {
        throw new Error('Некорректная модель окружения: compose.base/overlays');
    }
    if (!isMap(model.services) || !Object.keys(model.services).length) {
        throw new Error('Некорректная модель окружения: services');
    }
    for (const [name, service] of Object.entries(model.services)) {
        for (const field of SERVICE_FIELDS) {
            if (!Object.hasOwn(service, field)) throw new Error(`Некорректная модель окружения: ${name}.${field}`);
        }
        if (typeof service.image !== 'string') throw new Error(`Некорректная модель окружения: ${name}.image`);
        if (!Array.isArray(service.codeRoots) || service.codeRoots.some((item) => typeof item !== 'string')) {
            throw new Error(`Некорректная модель окружения: ${name}.codeRoots`);
        }
        if (service.envNotes !== undefined && !isMap(service.envNotes)) {
            throw new Error(`Некорректная модель окружения: ${name}.envNotes`);
        }
    }
}

/** Загружает модель production-окружения из репозитория. */
export async function loadEnvironmentModel(root, file = MODEL_FILE) {
    const model = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    validateModelShape(model);
    return model;
}

/** Частичная сверка: каждое поле модели против развёрнутого compose. */
export function structuralDrift(model, services) {
    const drift = [];
    for (const [name, spec] of Object.entries(model.services)) {
        const actual = services[name];
        if (!actual) {
            drift.push({ service: name, field: '(service)', model: 'present', compose: 'missing' });
            continue;
        }
        for (const field of SERVICE_FIELDS) {
            if (!deepEqual(spec[field], actual[field])) {
                drift.push({ service: name, field, model: spec[field], compose: actual[field] });
            }
        }
    }
    for (const name of Object.keys(services)) {
        if (!Object.hasOwn(model.services, name)) {
            drift.push({ service: name, field: '(service)', model: 'missing', compose: 'present' });
        }
    }
    return drift;
}

/** Имена секретов из services/shared/runtime.cjs — источник производных имён NAME_FILE. */
export async function parseSecretNames(root, file = RUNTIME_SECRET_NAMES_FILE) {
    const source = await readFile(path.join(root, file), 'utf8');
    const block = source.match(/const secretNames = \[([\s\S]*?)\];/);
    if (!block) throw new Error('secretNames не найден в ' + file);
    return [...block[1].matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]);
}

function assertInsideRoot(root, codeRoot) {
    if (!CODE_ROOT_PATTERN.test(codeRoot)) throw new Error('Некорректный codeRoot: ' + codeRoot);
    const base = path.resolve(root);
    const full = path.resolve(base, codeRoot);
    if (full !== base && !full.startsWith(base + path.sep))
        throw new Error('codeRoot за пределами репозитория: ' + codeRoot);
}

/** Исходники сервиса: codeRoots + services/shared, только производственные файлы. */
export function collectCodeFiles(root, codeRoots = []) {
    for (const codeRoot of codeRoots) {
        assertInsideRoot(root, codeRoot);
        if (!fsSync.statSync(path.join(root, codeRoot), { throwIfNoEntry: false })?.isDirectory()) {
            throw new Error('codeRoot не найден: ' + codeRoot);
        }
    }
    const files = [];
    const seen = new Set();
    const visit = (directory) => {
        let entries;
        try {
            entries = fsSync.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                if (!EXCLUDED_DIRECTORIES.has(entry.name)) visit(full);
            } else if (
                entry.isFile() &&
                !/\.test\.|\.spec\./.test(entry.name) &&
                CODE_FILE_EXTENSIONS.has(path.extname(entry.name))
            ) {
                const relative = path.relative(root, full);
                if (seen.has(relative)) continue;
                seen.add(relative);
                files.push({ file: relative, content: fsSync.readFileSync(full, 'utf8') });
            }
        }
    };
    for (const codeRoot of [...codeRoots, SHARED_CODE_ROOT]) visit(path.join(root, codeRoot));
    return files;
}

/**
 * Доказательство чтения env кодом: process.env.X, строковый литерал 'X'/".X", доступ .X
 * (чистые присваивания не считаются чтением) или производное NAME_FILE из secretNames.
 */
export function envReadInCode(name, codeFiles, secretNames = []) {
    if (!ENV_NAME_PATTERN.test(name)) throw new Error('Некорректное имя env: ' + name);
    if (name.endsWith('_FILE') && secretNames.includes(name.slice(0, -'_FILE'.length))) {
        return { mechanism: 'secret-file', file: RUNTIME_SECRET_NAMES_FILE };
    }
    const direct = new RegExp(`process\\.env\\.${name}(?![A-Za-z0-9_])(?!\\s*=(?!=))`);
    const literal = new RegExp(`['"]${name}['"]`);
    const property = new RegExp(`\\.${name}(?![A-Za-z0-9_])(?!\\s*=(?!=))`);
    for (const { file, content } of codeFiles) {
        for (const [mechanism, pattern] of [
            ['process.env', direct],
            ['literal', literal],
            ['property', property],
        ]) {
            if (pattern.test(content)) return { mechanism, file };
        }
    }
    return null;
}

/** Проверяет пометку env в модели: external / builtin / consumedBy:command. */
export function validateEnvNote(name, note, service) {
    if (!isMap(note)) return 'ожидается {external} | {builtin} | {consumedBy}';
    const kinds = Object.keys(note);
    if (kinds.length !== 1) return 'одна пометка на переменную, получено: ' + kinds.join(', ');
    const kind = kinds[0];
    if (kind === 'external') {
        if (typeof note.external !== 'string' || !note.external.trim())
            return 'external: укажите, чей образ читает переменную';
        if (!service.image || service.image.startsWith('neurocenter/')) {
            return 'external: допустима только для стороннего образа, у сервиса образ ' + (service.image ?? 'не задан');
        }
        return null;
    }
    if (kind === 'builtin') {
        if (typeof note.builtin !== 'string' || !note.builtin.trim())
            return 'builtin: укажите, какой runtime читает переменную';
        return null;
    }
    if (kind === 'consumedBy') {
        if (note.consumedBy !== 'command') return 'consumedBy: допустимо только "command"';
        if (!service.command.includes('$' + name)) {
            return `consumedBy:command: $${name} не найден в command сервиса`;
        }
        return null;
    }
    return 'неизвестная пометка: ' + kind;
}

/**
 * Dead-env (compose→code): переменная в compose-сервисе, которую не читает код
 * и которая не помечена в модели. Возвращает { dead, noteErrors }.
 */
export function deadEnvironment(model, services, { root, secretNames = [] }) {
    const dead = [];
    const noteErrors = [];
    const codeFiles = new Map();
    for (const [name, spec] of Object.entries(model.services)) {
        const service = services[name];
        if (!service) continue;
        const notes = spec.envNotes ?? {};
        if (!codeFiles.has(name)) codeFiles.set(name, collectCodeFiles(root, spec.codeRoots ?? []));
        for (const envName of Object.keys(service.env)) {
            const note = notes[envName];
            if (!note) {
                if (!envReadInCode(envName, codeFiles.get(name), secretNames))
                    dead.push({ service: name, env: envName });
                continue;
            }
            const error = validateEnvNote(envName, note, service);
            if (error) noteErrors.push({ service: name, env: envName, error });
        }
        for (const noteName of Object.keys(notes)) {
            if (!Object.hasOwn(service.env, noteName)) {
                noteErrors.push({ service: name, env: noteName, error: 'пометка без переменной в compose' });
            }
        }
    }
    return { dead, noteErrors };
}

/** Базовый production-стек: compose + overlay'и из модели, развёрнутые до сравнения. */
export async function loadProductionCompose(root, model) {
    const read = async (file) => parseComposeDocument(await readFile(path.join(root, file), 'utf8'));
    const documents = [await read(model.compose.base), ...(await Promise.all(model.compose.overlays.map(read)))];
    return normalizeServices(documents);
}
