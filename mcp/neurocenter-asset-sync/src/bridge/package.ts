import { createHash } from 'node:crypto';
import { hash } from './state.js';
import { parseLocalConfiguration } from '../features/local-configuration/schema.js';
import { normalizeRuntimeArtifacts, validateRuntimeArtifactEntrypoints, type RuntimeArtifact } from '../features/runtime-artifacts/model.js';

export interface Package {
    schemaVersion: number;
    plugin: { id: string; name: string; kind: string; version: number };
    config: {
        transport?: string;
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        headers?: Record<string, string>;
        oauth?: false;
        entrypoint?: string;
        extra?: { [key: string]: unknown; runtimeArtifacts?: RuntimeArtifact[]; localConfiguration?: unknown; requirements?: {mcp?: string[]; plugins?: string[]; dependencies?: Array<{kind:string;id:string;version:number;manifest:string}>} };
    } | null;
    files: Array<{
        path: string;
        content: string;
        size: number;
        sha256: string;
        encoding?: 'base64';
    }>;
    manifest: { sha256: string; filesCount: number };
}
export const canonical = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
                Object.entries(value)
                    .filter(([, v]) => v !== undefined)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => [k, canonical(v)]),
            )
          : value;

/** Формат 4 использует порядок кодовых единиц вместо зависимой от ОС локали. */
export const canonicalV4 = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalV4)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .filter(([, item]) => item !== undefined).sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1)
        .map(([key, item]) => [key, canonicalV4(item)])) : value;

/** Проверяет байты, переносимые пути и хэш всего манифеста до любой записи. */
export function verify(pkg: Package): void {
    if (
        ![2, 3, 4, 5].includes(pkg.schemaVersion) ||
        !['skill', 'plugin', 'mcp'].includes(pkg.plugin?.kind) ||
        pkg.files.length > 100 ||
        pkg.files.length !== pkg.manifest.filesCount
    ) {
        throw new Error('Некорректный манифест пакета.');
    }
    const artifacts = normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts);
    validateRuntimeArtifactEntrypoints(pkg.plugin.kind, artifacts);
    if ((artifacts.length || pkg.config?.extra?.localConfiguration !== undefined) && pkg.schemaVersion !== 5) { throw new Error('Готовые комплекты и локальная настройка требуют формат пакета 5.'); }
    parseLocalConfiguration(pkg);
    if (artifacts.length && (pkg.plugin.kind === 'skill' || pkg.config?.transport === 'remote')) { throw new Error('Готовый исполняемый комплект поддерживается только локальным MCP или плагином.'); }
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const file of pkg.files) {
        if (
            !file.path ||
            file.path.length > 240 ||
            file.path.includes('\\') ||
            file.path.startsWith('/') ||
            file.path
                .split('/')
                .some(
                    (part) =>
                        !part ||
                        part === '.' ||
                        part === '..' ||
                        /[<>:"|?*\x00-\x1f]/.test(part) ||
                        /[. ]$/.test(part) ||
                        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
                )
        ) {
            throw new Error('Недопустимый путь файла.');
        }
        const key = file.path.toLowerCase();
        if (
            paths.has(key) ||
            [...paths].some(
                (other) =>
                    other.startsWith(key + '/') || key.startsWith(other + '/'),
            )
        ) {
            throw new Error('Конфликт путей пакета.');
        }
        paths.add(key);
        if (![undefined, 'base64'].includes(file.encoding) || (pkg.schemaVersion === 2 && file.encoding !== undefined)) { throw new Error('Неподдерживаемое кодирование файла.'); }
        const bytes = typeof file.content === 'string' ? Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8') : Buffer.alloc(0);
        if (
            typeof file.content !== 'string' ||
            bytes.length !== file.size ||
            createHash('sha256').update(bytes).digest('hex') !== file.sha256
            || (file.encoding === 'base64' && bytes.toString('base64') !== file.content) ||
            file.size > 1048576
        ) {
            throw new Error('Повреждён файл пакета.');
        }
        totalBytes += file.size;
    }
    if (totalBytes > 5 * 1048576) {
        throw new Error('Пакет больше 5 МБ.');
    }
    const manifest = hash(
        JSON.stringify(
            (pkg.schemaVersion >= 4 ? canonicalV4 : canonical)({
                schemaVersion: pkg.schemaVersion,
                plugin: pkg.plugin,
                config: pkg.config,
                files: pkg.files
                    .map(({ path, size, sha256, encoding }) => ({ path, size, sha256, ...(encoding ? { encoding } : {}) }))
                    .sort((a, b) => pkg.schemaVersion >= 4 ? a.path === b.path ? 0 : a.path < b.path ? -1 : 1 : a.path.localeCompare(b.path)),
            }),
        ),
    );
    if (manifest !== pkg.manifest.sha256) {
        throw new Error('Хэш манифеста не совпадает.');
    }
    if (
        pkg.plugin.kind === 'skill' &&
        (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.plugin.name) ||
            !paths.has('skill.md'))
    ) {
        throw new Error('Некорректный пакет скилла.');
    }
}
