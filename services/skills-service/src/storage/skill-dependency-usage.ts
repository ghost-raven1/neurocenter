import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { normalizeDependencyPins } from '../../../shared/dependency-pins.cjs';
import { parseSkillFile } from './frontmatter';
import { SKILL_JOURNAL_DIRECTORY, parseSkillJournal } from './skill-journal';
import { SKILL_VERSIONS_DIRECTORY } from './skill-versions';
import { isSkillDirectoryChange } from './skill-directory-change';

/** Проверяет головы, все поколения истории и обе стороны ещё существующих журналов. */
export async function scanSkillDependencyUsage(root: string, assetId: string): Promise<boolean> {
    let inUse = false;
    const inspect = (raw: string) => {
        const { meta } = parseSkillFile(raw);
        if (!meta) { throw new Error('Повреждён frontmatter.'); }
        if (normalizeDependencyPins(meta.dependencies).some(pin => pin.id === assetId)) { inUse = true; }
    };
    const read = async (filename: string): Promise<string> => {
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if (!(await handle.stat()).isFile()) { throw new Error('Ожидался обычный файл.'); }
            return await handle.readFile('utf8');
        } finally { await handle.close(); }
    };
    const walk = async (directory: string, mode: 'heads' | 'versions' | 'journals'): Promise<void> => {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Недопустимый каталог.'); }
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) { throw new Error('Хранилище содержит симлинк.'); }
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                const childMode = mode === 'heads' && entry.name === SKILL_VERSIONS_DIRECTORY ? 'versions'
                    : mode === 'heads' && entry.name === SKILL_JOURNAL_DIRECTORY ? 'journals' : mode;
                await walk(filename, childMode);
            } else if (entry.isFile()) {
                if (mode === 'heads' && entry.name.endsWith('.md') || mode === 'versions' && entry.name.endsWith('.snapshot')) {
                    inspect(await read(filename));
                } else if (mode === 'journals' && entry.name.endsWith('.json')) {
                    for (const change of parseSkillJournal(await read(filename), filename).changes) {
                        if (isSkillDirectoryChange(change)) { continue; }
                        if (!change.relative.endsWith('.md') || !change.relative.slice(0, -3).split('/').every(part => /^[a-z0-9][a-z0-9_-]*$/.test(part))) {
                            throw new Error('Повреждён путь в журнале.');
                        }
                        if (change.before !== null) { inspect(change.before); }
                        if (change.after !== null) { inspect(change.after); }
                    }
                }
            } else { throw new Error('Хранилище содержит специальный файл.'); }
        }
    };
    try { await walk(path.resolve(root), 'heads'); }
    catch { throw new ServiceUnavailableException('Не удалось полностью проверить зависимости скиллов. Удаление инструмента остановлено.'); }
    return inUse;
}
