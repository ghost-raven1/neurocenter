import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { scanSkills } from './scan-skills.js';

/** Базовый URL skills-service (ingest-эндпоинт). */
import { authorizedFetch } from '../bridge/state.js';

export const syncSkillsInputSchema = z.object({
    root: z.string().optional().describe('Корень проекта (деф. CWD) — там ищут .opencode/skills.'),
    projectKey: z
        .string()
        .min(1)
        .describe('Ключ проекта в панели (напр. prj-example-project) — куда синхронизировать.'),
    dryRun: z.boolean().optional().describe('true — только список найденных скиллов, без записи.'),
});
export type TSyncSkillsInput = z.infer<typeof syncSkillsInputSchema>;

/** Нагрузка карточки скилла для ingest-эндпоинта skills-service (методанные + тело). */
interface ISkillSyncItem {
    name: string;
    slug: string;
    body: string;
    description?: string;
    mcp?: string[];
    plugins?: string[];
    tags?: string[];
    specialization?: string;
    version?: number;
}

/**
 * Отделяет YAML-frontmatter от тела и извлекает `description`.
 *
 * @param raw - полный текст SKILL.md.
 * @returns тело (без frontmatter) и описание.
 */
function splitCard(raw: string): { body: string; description?: string } {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) {
        return { body: raw };
    }
    const full = m[0] ?? raw;
    const fm = m[1] ?? '';
    const dm = fm.match(/^description:\s*(.*)$/m);

    let description: string | undefined;

    if (dm) {
        const first = (dm[1] ?? '').trim();

        if (/^[>|][+-]?$/.test(first)) {
            const lines = fm.split(/\r?\n/);
            const idx = lines.findIndex((l) => /^description:\s*[>|][+-]?\s*$/.test(l));
            const block: string[] = [];

            for (let i = idx + 1; i < lines.length; i += 1) {
                const line = lines[i] ?? '';

                if (line.trim() === '') {
                    continue;
                }
                if (/^\S/.test(line)) {
                    break;
                }
                block.push(line.trim());
            }

            description = block.join(' ').trim();
        } else {
            description = first;
        }
    }

    return {
        body: raw.slice(full.length).replace(/^\s+/, ''),
        description: description || undefined,
    };
}

/**
 * Синхронизация скиллов проекта в панель: scan `.opencode/skills` → POST `/api/skills/sync`.
 *
 * @param input - параметры (root/projectKey/dryRun).
 * @returns сводка (scanned/upserted/removed) либо ошибка.
 */
export async function syncSkills(input: TSyncSkillsInput): Promise<unknown> {
    const rootAbs = path.resolve(input.root ? input.root : process.cwd());
    const skillsRoot = path.join(rootAbs, '.opencode', 'skills');

    if (!existsSync(skillsRoot)) {
        return { ok: false, error: `Каталог скиллов не найден: ${skillsRoot}` };
    }

    const scan = await scanSkills(rootAbs, 5);

    if (scan.errors.length) {
        return {
            ok: false,
            projectKey: input.projectKey,
            error: 'Сканирование скиллов не завершено. Серверный каталог не изменён.',
            sourceErrors: scan.errors,
        };
    }
    if (scan.skills.length === 0) {
        return { ok: false, projectKey: input.projectKey, scanned: 0, note: 'Скиллы не найдены', errors: scan.errors };
    }

    const items: ISkillSyncItem[] = [];

    for (const card of scan.skills) {
        const raw = await fs.readFile(card.path, 'utf8');
        const { body, description } = splitCard(raw);

        items.push({
            name: card.name,
            slug: path.basename(card.directory),
            body,
            description,
            mcp: card.mcp,
            plugins: card.plugins,
            tags: card.tags,
            specialization: card.specialization ?? undefined,
            version: Number(card.version) || undefined,
        });
    }

    if (input.dryRun) {
        return {
            ok: true,
            dryRun: true,
            projectKey: input.projectKey,
            scanned: items.length,
            skills: items.map((i) => i.name),
        };
    }

    const res = await authorizedFetch('/api/skills/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectKey: input.projectKey, skills: items }),
    });
    const json: unknown = await res.json();

    if (!res.ok) {
        return {
            ok: false,
            projectKey: input.projectKey,
            scanned: items.length,
            error: `skills-service → ${res.status}`,
            detail: json,
        };
    }

    const summary = json as { upserted?: number; removed?: number; total?: number };

    return {
        ok: true,
        projectKey: input.projectKey,
        scanned: items.length,
        upserted: summary.upserted ?? 0,
        removed: summary.removed ?? 0,
        sourceErrors: scan.errors,
    };
}
