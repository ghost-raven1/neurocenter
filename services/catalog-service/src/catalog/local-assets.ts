import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface ILocalAssetProject {
    project: string;
    path: string;
    skills: string[];
    mcpServers: string[];
    /** Конфигурации MCP-серверов из opencode.json (имя → объект mcp.<name>). */
    mcpConfigs: Record<string, Record<string, unknown>>;
    plugins: string[];
}

export interface ILocalAssetsScan {
    root: string;
    query: string | null;
    projects: ILocalAssetProject[];
    scannedCount: number;
    totalProjects: number;
}

function isDir(p: string): Promise<boolean> {
    return fs.stat(p).then((s) => s.isDirectory()).catch(() => false);
}

function isFile(p: string): Promise<boolean> {
    return fs.stat(p).then((s) => s.isFile()).catch(() => false);
}

/**
 * Разрешает корень скана: относительно home, без абсолютных путей и «..»
 * (защита от выхода за пределы рабочих каталогов пользователя).
 *
 * @param root - базовый каталог (относительно home, опционально).
 * @returns {string} абсолютный путь корня скана.
 * @throws {Error} при недопустимом корне.
 */
function resolveScanRoot(root?: string): string {
    if (root === undefined || root.trim().length === 0) {
        return projectsRoot();
    }
    const cleaned = root.trim().replace(/^~\/?/, '');

    if (path.isAbsolute(cleaned) || cleaned.includes('..')) {
        throw new Error('Недопустимый корень скана (запрещены абсолютные пути и «..»)');
    }

    return path.resolve(os.homedir(), cleaned);
}

/** Единый корень проектов для скана, установки и проверки путей на хосте и в контейнере. */
function projectsRoot(): string {
    return path.resolve(process.env.PROJECTS_ROOT || path.join(os.homedir(), 'projects'));
}

/**
 * Разрешает `fs_root_path` проекта: абсолютный путь внутри настроенного PROJECTS_ROOT
 * (защита от наведения restore/sync на чужие каталоги).
 *
 * @param value - `fsRootPath` из запроса.
 * @returns {string} нормализованный абсолютный путь.
 * @throws {Error} если путь не абсолютный или выходит за пределы PROJECTS_ROOT.
 */
export function resolveFsRootPath(value: string): string {
    if (!path.isAbsolute(value)) { throw new Error('fsRootPath должен быть абсолютным путём'); }
    const p = path.resolve(value);
    const root = projectsRoot();

    if (p !== root && !p.startsWith(`${root}${path.sep}`)) {
        throw new Error('fsRootPath должен находиться внутри каталога проектов');
    }

    return p;
}

/**
 * Скан локальных проектов под базовым каталогом (деф. ~/projects): что где установлено
 * (скиллы .opencode/skills, MCP opencode.json → mcp, плагины .opencode/plugins).
 *
 * @param root - базовый каталог (относительно home, опционально).
 * @param query - фильтр по названию проекта (подстрока, без учёта регистра).
 * @param maxProjects - максимум проектов.
 * @returns {Promise<ILocalAssetsScan>}
 */
export async function scanLocalAssets(root?: string, query?: string, maxProjects = 100): Promise<ILocalAssetsScan> {
    const base = resolveScanRoot(root);
    let names: string[] = [];
    try {
        names = await fs.readdir(base);
    } catch {
        names = [];
    }

    const projects: ILocalAssetProject[] = [];
    for (const name of names) {
        if (projects.length >= maxProjects) {
            break;
        }
        const p = path.join(base, name);
        if (!(await isDir(p))) {
            continue;
        }

        const skills: string[] = [];
        const skillDir = path.join(p, '.opencode', 'skills');
        try {
            const es = await fs.readdir(skillDir, { withFileTypes: true });
            for (const e of es) {
                if (e.isDirectory() && (await isFile(path.join(skillDir, e.name, 'SKILL.md')))) {
                    skills.push(e.name);
                }
            }
        } catch {
            // нет каталога скиллов.
        }

        const mcpServers: string[] = [];
        const mcpConfigs: Record<string, Record<string, unknown>> = {};
        for (const c of [
            path.join(p, '.opencode', 'opencode.json'),
            path.join(p, 'opencode.json'),
            path.join(p, '.opencode', 'opencode.jsonc'),
        ]) {
            try {
                const j = (JSON.parse(await fs.readFile(c, 'utf8')) as { mcp?: Record<string, unknown> }) ?? {};
                if (j.mcp) {
                    for (const [ name, value ] of Object.entries(j.mcp)) {
                        mcpServers.push(name);
                        if (value && typeof value === 'object' && !Array.isArray(value)) {
                            mcpConfigs[name] = value as Record<string, unknown>;
                        }
                    }
                    break;
                }
            } catch {
                // нет конфига.
            }
        }

        const plugins: string[] = [];
        const pluginDir = path.join(p, '.opencode', 'plugins');
        try {
            const es = await fs.readdir(pluginDir);
            for (const e of es) {
                if (/\.(js|ts|mjs|zip)$/i.test(e)) {
                    plugins.push(e.replace(/\.(js|ts|mjs|zip)$/i, ''));
                }
            }
        } catch {
            // нет каталога плагинов.
        }

        projects.push({ project: name, path: p, skills, mcpServers, mcpConfigs, plugins });
    }

    const q = (query && query.trim()) ? query.trim().toLowerCase() : null;
    const filtered = q ? projects.filter((pr) => pr.project.toLowerCase().includes(q)) : projects;

    return { root: base, query: q, projects: filtered, scannedCount: projects.length, totalProjects: filtered.length };
}
