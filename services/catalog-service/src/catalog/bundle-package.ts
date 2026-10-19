import { createHash } from 'node:crypto';
import type { IAiPluginConfig } from './dto';
import { normalizeRuntimeArtifacts } from '../../../shared/runtime-artifacts.cjs';
import { publicationHash } from '../publication/publication-validation';

/** Файл delivery-пакета (текст + sha256). */
export interface IPackageFile {
    path: string;
    size: number;
    sha256: string;
    content: string;
    encoding?: 'base64';
}

/** Self-verified delivery-пакет бандла (пересчитываемые хэши для проверки при доставке). */
export interface IPackage {
    schemaVersion: 2 | 3 | 4 | 5;
    config: IAiPluginConfig | null;
    plugin: {
        id: string;
        name: string;
        kind: string;
        version: number;
    };
    files: IPackageFile[];
    manifest: {
        sha256: string;
        createdAt: string;
        filesCount: number;
    };
}

/**
 * sha256 (hex) над строкой (utf8).
 *
 * @param {string} data - строка.
 * @returns {string} hex-хэш.
 */
export function sha256Hex(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Собирает self-verified package из файлов: per-file sha256 + manifest.sha256
 * (над упорядоченным списком `path:sha256`).
 *
 * @param {object} plugin - метаданные бандла.
 * @param {Array<{ path: string; content: string }>} files - файлы (текст).
 * @param {string} createdAt - метка времени пакета.
 * @returns {IPackage}
 */
export function buildPackage(
    plugin: { id: string; name: string; kind: string; version: number },
    files: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>,
    createdAt: string,
    config: IAiPluginConfig | null = null,
): IPackage {
    // Даже ASCII-пути и ключи конфигурации имеют разный порядок в некоторых локалях.
    const runtimeArtifacts = normalizeRuntimeArtifacts(config?.extra?.runtimeArtifacts);
    if (runtimeArtifacts.length && (plugin.kind === 'skill' || config?.transport === 'remote')) { throw new Error('Готовый исполняемый комплект поддерживается только локальным MCP или плагином.'); }
    const schemaVersion = runtimeArtifacts.length || config?.extra?.localConfiguration !== undefined ? 5 : 4;
    const pkgFiles: IPackageFile[] = files.map(f => {
        const bytes = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
        if (f.encoding === 'base64' && bytes.toString('base64') !== f.content) { throw new Error('Некорректный base64 ресурса.'); }
        return { path: f.path, content: f.content, size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            ...(f.encoding === 'base64' ? { encoding: 'base64' as const } : {}) };
    });
    const manifest = packageHash(plugin, config, pkgFiles, schemaVersion);
    return { schemaVersion, config, plugin, files: pkgFiles,
        manifest: { sha256: manifest, createdAt, filesCount: pkgFiles.length } };

}

/**
 * Проверяет целостность пакета: per-file sha256 совпадают с content,
 * manifest.sha256 пересчитывается и совпадает, filesCount корректен.
 *
 * @param {IPackage} pkg - пакет (с content).
 * @returns {boolean} true — целостность подтверждена.
 */
export function verifyPackage(pkg: IPackage): boolean {
    try {
        const artifacts = normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts);
        if (artifacts.length && (pkg.plugin.kind === 'skill' || pkg.config?.transport === 'remote')) { return false; }
        if ((artifacts.length || pkg.config?.extra?.localConfiguration !== undefined) && pkg.schemaVersion !== 5) { return false; }
    } catch { return false; }
    if (pkg.files.length !== pkg.manifest.filesCount) {
        return false;
    }
    for (const f of pkg.files) {
        if (typeof f.content !== 'string' || ![undefined, 'base64'].includes(f.encoding) || (pkg.schemaVersion === 2 && f.encoding !== undefined)) { return false; }
        const bytes = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
        if (f.encoding === 'base64' && bytes.toString('base64') !== f.content || bytes.length !== f.size || createHash('sha256').update(bytes).digest('hex') !== f.sha256) {
            return false;
        }
    }
    if (![2, 3, 4, 5].includes(pkg.schemaVersion)) { return false; }
    const manifest = packageHash(pkg.plugin, pkg.config, pkg.files, pkg.schemaVersion);
    return manifest === pkg.manifest.sha256;
}

/** Канонический формат 4 не зависит от языка ОС; форматы 2/3 сохраняют прежний контракт. */
const canonicalV4 = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalV4)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
        .filter(([, item]) => item !== undefined).sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1)
        .map(([key, item]) => [key, canonicalV4(item)])) : value;

/** Хэш включает подключение MCP и идентичность версии, а не только дерево файлов. */
function packageHash(plugin: IPackage['plugin'], config: IAiPluginConfig | null, files: IPackageFile[], schemaVersion: 2 | 3 | 4 | 5): string {
    const content = {schemaVersion, plugin, config, files:files.map(({path,size,sha256,encoding})=>({path,size,sha256,...(encoding ? {encoding} : {})}))
        .sort((a,b)=>schemaVersion >= 4 ? a.path === b.path ? 0 : a.path < b.path ? -1 : 1 : a.path.localeCompare(b.path))};
    return schemaVersion >= 4 ? sha256Hex(JSON.stringify(canonicalV4(content))) : publicationHash(content);
}
