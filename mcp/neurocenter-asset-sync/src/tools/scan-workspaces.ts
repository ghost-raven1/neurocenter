import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

export const scanWorkspacesInputSchema = z
    .object({
        root: z
            .string()
            .optional()
            .describe('Базовый каталог с проектами (деф. ~/projects). Каждый подкаталог считается проектом.'),
        query: z
            .string()
            .optional()
            .describe('Фильтр по названию проекта (поиск подстроки, без учёта регистра).'),
        maxProjects: z.number().int().positive().optional().describe('Максимум проектов в отчёте (деф. 100).'),
    })
    .strict();

export type TScanWorkspacesInput = z.infer<typeof scanWorkspacesInputSchema>;

export interface IWorkspaceAsset {
    project: string;
    path: string;
    skills: string[];
    mcpServers: string[];
    plugins: string[];
}

export interface IWorkspacesScan {
    root: string;
    query: string | null;
    projects: IWorkspaceAsset[];
    scannedCount: number;
    totalProjects: number;
}

async function isDir(p: string): Promise<boolean> {
    try {
        return (await fs.stat(p)).isDirectory();
    } catch {
        return false;
    }
}

async function isFile(p: string): Promise<boolean> {
    try {
        return (await fs.stat(p)).isFile();
    } catch {
        return false;
    }
}

function readJson(p: string): Promise<{ mcp?: Record<string, unknown> } | null> {
    return (async () => {
        try {
            return (JSON.parse(await fs.readFile(p, 'utf8')) as { mcp?: Record<string, unknown> }) ?? null;
        } catch {
            return null;
        }
    })();
}

/**
 * Скан проектов под базовым каталогом: для каждого проекта определяет установленные
 * opencode-скиллы (.opencode/skills/&lt;/&gt;/SKILL.md), MCP-серверы (opencode.json → mcp)
 * и плагины (.opencode/plugins).
 *
 * @param input - параметры скана.
 * @returns {Promise<IWorkspacesScan>} сводка по проектам.
 */
export async function scanWorkspaces(input: TScanWorkspacesInput): Promise<IWorkspacesScan> {
    const root = input.root ? path.resolve(os.homedir(), input.root) : path.join(os.homedir(), 'projects');
    const maxProjects = input.maxProjects ?? 100;
    let names: string[] = [];
    try {
        names = await fs.readdir(root);
    } catch {
        names = [];
    }

    const projects: IWorkspaceAsset[] = [];
    for (const name of names) {
        if (projects.length >= maxProjects) {
            break;
        }
        const p = path.join(root, name);
        if (!(await isDir(p))) {
            continue;
        }

        const skills: string[] = [];
        const skillDir = path.join(p, '.opencode', 'skills');
        try {
            const entries = await fs.readdir(skillDir, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory() && (await isFile(path.join(skillDir, e.name, 'SKILL.md')))) {
                    skills.push(e.name);
                }
            }
        } catch {
            // каталог скиллов отсутствует.
        }

        const mcpServers: string[] = [];
        for (const candidate of [
            path.join(p, '.opencode', 'opencode.json'),
            path.join(p, 'opencode.json'),
            path.join(p, '.opencode', 'opencode.jsonc'),
        ]) {
            const cfg = await readJson(candidate);
            if (cfg && typeof cfg.mcp === 'object' && cfg.mcp) {
                mcpServers.push(...Object.keys(cfg.mcp));
                break;
            }
        }

        const plugins: string[] = [];
        const pluginDir = path.join(p, '.opencode', 'plugins');
        try {
            const entries = await fs.readdir(pluginDir);
            for (const e of entries) {
                if (e.endsWith('.js') || e.endsWith('.ts') || e.endsWith('.zip') || e.endsWith('.mjs')) {
                    plugins.push(e.replace(/\.(js|ts|mjs|zip)$/i, ''));
                }
            }
        } catch {
            // каталог плагинов отсутствует.
        }

        projects.push({ project: name, path: p, skills, mcpServers, plugins });
    }

    const q = input.query ? input.query.trim().toLowerCase() : null;
    const filtered = q ? projects.filter(pr => pr.project.toLowerCase().includes(q)) : projects;

    return {
        root,
        query: q ?? null,
        projects: filtered,
        scannedCount: projects.length,
        totalProjects: filtered.length,
    };
}
