import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { extractFrontmatter } from '../lib/frontmatter.js';

export const scanSkillsInputSchema = z
    .object({
        root: z.string().optional().describe('Каталог с .opencode/skills (деф. = CWD/корень воркспейса).'),
        maxDepth: z.number().int().min(1).max(8).default(4).describe('Глубина обхода подкаталогов.'),
    })
    .strict();

export type TScanSkillsInput = z.infer<typeof scanSkillsInputSchema>;

export interface ISkillCard {
    name: string;
    slug: string | null;
    scope: 'common' | 'project';
    projectId: string | null;
    mcp: string[];
    plugins: string[];
    specialization: string | null;
    tags: string[];
    version: string | null;
    path: string;
    directory: string;
}

export interface ISkillError {
    path: string;
    error: string;
}

export interface ISkillScan {
    root: string;
    skillsDir: string | null;
    cardCount: number;
    skills: ISkillCard[];
    errors: ISkillError[];
}

const SKIP = new Set(['.git', 'node_modules', '.opencode', 'rag_db']);

async function isDir(p: string): Promise<boolean> {
    try {
        const s = await fs.stat(p);
        return s.isDirectory();
    } catch {
        return false;
    }
}

/**
 * Определяет стартовый каталог обхода: `.opencode/skills`, затем `skills`,
 * затем сам `root` (если туда передали skills-dir напрямую).
 */
async function resolveSkillsDir(rootAbs: string): Promise<string | null> {
    const candidates = [path.join(rootAbs, '.opencode', 'skills'), path.join(rootAbs, 'skills'), rootAbs];
    for (const c of candidates) {
        if (await isDir(c)) {
            return c;
        }
    }
    return null;
}

interface ISkillFront {
    name?: unknown;
    slug?: unknown;
    scope?: unknown;
    projectId?: unknown;
    mcp?: unknown;
    plugins?: unknown;
    specialization?: unknown;
    tags?: unknown;
    version?: unknown;
}

function toStrArr(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function toStr(v: unknown): string | null {
    return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function toVersion(v: unknown): string | null {
    if (typeof v === 'string' && v.trim() !== '') {
        return v;
    }
    if (typeof v === 'number') {
        return String(v);
    }
    return null;
}

/**
 * Обходит `root` в поисках всех `SKILL.md` и парсит их frontmatter в карточки.
 *
 * @param rootAbs - абсолютный корень обхода.
 * @param maxDepth - максимальная глубина вложенности.
 */
export async function scanSkills(rootAbs: string, maxDepth: number): Promise<ISkillScan> {
    const skills: ISkillCard[] = [];
    const errors: ISkillError[] = [];

    const startDir = await resolveSkillsDir(rootAbs);
    if (!startDir) {
        return { root: rootAbs, skillsDir: null, cardCount: 0, skills, errors };
    }

    async function walk(dir: string, depth: number): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            errors.push({ path: dir, error: 'Не удалось прочитать папку скиллов' });
            return;
        }
        for (const e of entries) {
            if (SKIP.has(e.name)) {
                continue;
            }
            const full = path.join(dir, e.name);
            if (e.isSymbolicLink()) {
                errors.push({ path: full, error: 'Символьная ссылка пропущена; состав каталога неизвестен' });
                continue;
            }
            if (e.isDirectory()) {
                if (depth < maxDepth) {
                    await walk(full, depth + 1);
                } else {
                    errors.push({ path: full, error: 'Достигнута глубина обхода; состав каталога неизвестен' });
                }
            } else if (e.isFile() && e.name === 'SKILL.md') {
                const card = await readCard(full);
                if (card) {
                    skills.push(card);
                } else {
                    errors.push({ path: full, error: 'не удалось прочитать/парсить SKILL.md' });
                }
            }
        }
    }

    await walk(startDir, 0);
    skills.sort((a, b) => a.path.localeCompare(b.path));
    return {
        root: rootAbs,
        skillsDir: startDir,
        cardCount: skills.length,
        skills,
        errors,
    };
}

async function readCard(full: string): Promise<ISkillCard | null> {
    let raw: string;
    try {
        raw = await fs.readFile(full, 'utf8');
    } catch {
        return null;
    }
    const fm = extractFrontmatter<ISkillFront>(raw);
    if (!fm) {
        return null;
    }
    return {
        name: toStr(fm.name) ?? 'unnamed',
        slug: toStr(fm.slug),
        scope: toStr(fm.scope) === 'project' ? 'project' : 'common',
        projectId: toStr(fm.projectId),
        mcp: toStrArr(fm.mcp),
        plugins: toStrArr(fm.plugins),
        specialization: toStr(fm.specialization),
        tags: toStrArr(fm.tags),
        version: toVersion(fm.version),
        path: full,
        directory: path.dirname(full),
    };
}
