import { z } from 'zod';

/** Базовый URL catalog-service (dev: local :4100; prod — через gateway). */
import { authorizedFetch } from '../bridge/state.js';

/** Файл бандла в каталоге (manifest + текст). */
interface ICatFile {
    path: string;
    content?: string;
}

/** Карточка MCP/плагина из каталога (то, что нужно для бандла). */
interface ICatPlugin {
    id: string;
    name: string;
    kind: string;
    version?: number;
    config?: Record<string, unknown> | null;
    files?: ICatFile[];
}

/**
 * GET из catalog-service.
 *
 * @param {string} route - путь после /api.
 * @returns {Promise<T>} распarsed JSON.
 */
async function catalogGet<T>(route: string): Promise<T> {
    const r = await authorizedFetch(`/api${route}`);
    if (!r.ok) {
        throw new Error(`catalog GET ${route} → HTTP ${r.status}`);
    }
    return (await r.json()) as T;
}

// ─────────────────────────── 1. list_bundle_versions ───────────────────────────

export const bundleVersionsInputSchema = z
    .object({
        plugin: z.string().min(1).describe('id или имя MCP/плагина из каталога.'),
    })
    .strict();
export type TBundleVersionsInput = z.infer<typeof bundleVersionsInputSchema>;

/**
 * Список версий бандла (нечуящая история) из каталога.
 *
 * @param {TBundleVersionsInput} input - plugin (id/имя).
 * @returns {Promise<string>} JSON с версиями.
 */
export async function listBundleVersions(input: TBundleVersionsInput): Promise<string> {
    interface IVersion {
        version: number;
        files: ICatFile[];
        author: string;
        note: string;
        createdAt: string;
    }
    const versions = await catalogGet<IVersion[]>(`/ai-plugins/${encodeURIComponent(input.plugin)}/versions`);
    const out = versions.map((v) => ({
        version: v.version,
        files: v.files?.length ?? 0,
        author: v.author,
        note: v.note,
        createdAt: v.createdAt,
    }));
    return JSON.stringify({ ok: true, plugin: input.plugin, versions: out });
}

// ────────────────────────────── 2. read_bundle_file ──────────────────────────────

export const bundleFileInputSchema = z
    .object({
        plugin: z.string().min(1).describe('id или имя MCP/плагина из каталога.'),
        path: z.string().min(1).describe('Относительный путь файла в бандле (напр. SKILL.md, references/notes.md).'),
        version: z.number().int().positive().optional().describe('Версия бандла (не задан — head).'),
    })
    .strict();
export type TBundleFileInput = z.infer<typeof bundleFileInputSchema>;

/**
 * Чтение содержимого файла бандла (head или конкретная версия).
 *
 * @param {TBundleFileInput} input - plugin, path, version?.
 * @returns {Promise<string>} JSON файлом (path/size/digest/content).
 */
export async function readBundleFile(input: TBundleFileInput): Promise<string> {
    const q = new URLSearchParams({ path: input.path });
    if (input.version != null) {
        q.set('version', String(input.version));
    }
    const file = await catalogGet<ICatFile>(`/ai-plugins/${encodeURIComponent(input.plugin)}/files?${q.toString()}`);
    return JSON.stringify({ ok: true, ...file });
}

// ─────────────────────────── 3. activate_bundle_version ───────────────────────────

export const bundleActivateInputSchema = z
    .object({
        plugin: z.string().min(1).describe('id или имя MCP/плагина из каталога.'),
        version: z.number().int().positive().describe('Версия, которую делаем head (откат).'),
    })
    .strict();
export type TBundleActivateInput = z.infer<typeof bundleActivateInputSchema>;

/**
 * Откат bандла к указанной версии (make head).
 *
 * @param {TBundleActivateInput} input - plugin, version.
 * @returns {Promise<string>} JSON результата.
 */
export async function activateBundleVersion(input: TBundleActivateInput): Promise<string> {
    const r = await authorizedFetch(
        `/api/ai-plugins/${encodeURIComponent(input.plugin)}/versions/${Number(input.version)}/activate`,
        { method: 'POST' },
    );
    if (!r.ok) {
        throw new Error(`catalog activate ${input.version} → HTTP ${r.status}`);
    }
    const data = (await r.json()) as ICatPlugin;
    return JSON.stringify({ ok: true, activatedVersion: input.version, headVersion: data.version, name: data.name });
}
