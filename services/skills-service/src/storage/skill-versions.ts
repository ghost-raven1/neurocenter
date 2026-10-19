import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ISkillMeta } from '../skills/skills.model';

export const SKILL_VERSIONS_DIRECTORY = '.neurocenter-skill-versions';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** История новой публикации с тем же путём не смешивается с удалённым скиллом. */
export function versionRelative(skillPath: string, meta: ISkillMeta, version: number): string {
    const generation = meta.generation || JSON.stringify(meta.history[0]);
    return `${SKILL_VERSIONS_DIRECTORY}/${hash(skillPath)}/${hash(generation)}/${version}.snapshot`;
}

export async function syncSkillDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
}

/** Неизменяемый снимок прежней версии фиксируется до переключения текущего файла. */
export async function preserveVersion(file: string, raw: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(raw, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        try { await fs.link(temporary, file); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            if (await fs.readFile(file, 'utf8') !== raw) { throw new Error('История версии повреждена; публикация остановлена.'); }
        }
        await syncSkillDirectory(path.dirname(file));
    } finally { await fs.rm(temporary, { force: true }); }
}
