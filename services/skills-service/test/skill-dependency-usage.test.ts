import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanSkillDependencyUsage } from '../src/storage/skill-dependency-usage';
import { normalizeMeta, serializeSkillFile } from '../src/storage/frontmatter';
import { SKILL_VERSIONS_DIRECTORY } from '../src/storage/skill-versions';
import { SKILL_JOURNAL_DIRECTORY } from '../src/storage/skill-journal';

const assetId = 'ai-plug-dependent';
const pin = { kind: 'mcp', id: assetId, version: 1, manifest: 'a'.repeat(64) };
const text = (dependencies: unknown = [pin]) => serializeSkillFile(normalizeMeta({ name: 'Инструкция', dependencies }, 'helper'), 'Текст');

describe('Полная проверка файловых ссылок скиллов', () => {
    let root: string;
    const write = async (relative: string, raw: string) => {
        const filename = path.join(root, relative);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, raw);
    };
    const journal = (before: string | null, after: string | null, state = 'prepared') => JSON.stringify({
        version: 1, id: 'journal', host: os.hostname(), pid: process.pid, state,
        changes: [{ relative: 'common/helper.md', before, after }],
    });
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-skill-usage-')); });
    afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

    it('Пустое исправное хранилище не содержит ссылки', async () => {
        expect(await scanSkillDependencyUsage(root, assetId)).toBe(false);
    });
    it('Находит точный ID в голове и не путает его с legacy-именем', async () => {
        await write('common/helper.md', text());
        expect(await scanSkillDependencyUsage(root, assetId)).toBe(true);
        expect(await scanSkillDependencyUsage(root, assetId + '-other')).toBe(false);
        await write('common/helper.md', serializeSkillFile(normalizeMeta({ mcp: [assetId] }, 'helper'), 'Текст'));
        expect(await scanSkillDependencyUsage(root, assetId)).toBe(false);
    });
    it('Ссылка остаётся активной в истории удалённого поколения без головы', async () => {
        await write(`${SKILL_VERSIONS_DIRECTORY}/old-path/old-generation/1.snapshot`, text());
        await write(`${SKILL_VERSIONS_DIRECTORY}/old-path/new-generation/1.snapshot`, text([]));
        expect(await scanSkillDependencyUsage(root, assetId)).toBe(true);
    });
    it.each(['prepared', 'committed'])('Проверяет before и after журнала %s', async state => {
        const filename = `${SKILL_JOURNAL_DIRECTORY}/${createHash('sha256').update('common').digest('hex')}.json`;
        await write(filename, journal(text(), text([]), state));
        expect(await scanSkillDependencyUsage(root, assetId)).toBe(true);
        await write(filename, journal(null, text(), state));
        expect(await scanSkillDependencyUsage(root, assetId)).toBe(true);
    });
    it.each(['common/broken.md', `${SKILL_VERSIONS_DIRECTORY}/old/old/1.snapshot`])('Повреждённый frontmatter %s останавливает удаление', async relative => {
        await write(relative, '---\ndependencies: [\n---\nТекст');
        await expect(scanSkillDependencyUsage(root, assetId)).rejects.toMatchObject({ status: 503 });
    });
    it('Некорректный pin не считается отсутствующей зависимостью', async () => {
        await write('common/broken.md', '---\ndependencies:\n  - id: ai-plug-dependent\n---\nТекст');
        await expect(scanSkillDependencyUsage(root, assetId)).rejects.toMatchObject({ status: 503 });
    });
    it.each(['{', JSON.stringify({ version: 1, changes: [] }), journal('Нет frontmatter', null)])('Повреждённый журнал не разрешает удаление: %s', async raw => {
        await write(`${SKILL_JOURNAL_DIRECTORY}/${createHash('sha256').update('common').digest('hex')}.json`, raw);
        await expect(scanSkillDependencyUsage(root, assetId)).rejects.toMatchObject({ status: 503 });
    });
    it('Проверяет остаток хранилища даже после найденной ссылки', async () => {
        await write('a.md', text());
        await write('z.md', 'Повреждённый файл');
        await expect(scanSkillDependencyUsage(root, assetId)).rejects.toMatchObject({ status: 503 });
    });
    it.each(['file', 'directory', 'root'])('Симлинк %s не даёт частичного результата', async kind => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-skill-external-'));
        try {
            await fs.writeFile(path.join(outside, 'helper.md'), text([]));
            const linked = kind === 'root' ? path.join(root, 'linked') : path.join(root, 'common');
            await fs.symlink(kind === 'file' ? path.join(outside, 'helper.md') : outside, linked);
            await expect(scanSkillDependencyUsage(kind === 'root' ? linked : root, assetId)).rejects.toMatchObject({ status: 503 });
        } finally { await fs.rm(outside, { recursive: true, force: true }); }
    });
    it('Исчезновение корня и ошибка чтения не превращаются в false', async () => {
        await expect(scanSkillDependencyUsage(path.join(root, 'missing'), assetId)).rejects.toMatchObject({ status: 503 });
        await write('common/helper.md', text([]));
        vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('Ошибка диска'), { code: 'EIO' }));
        await expect(scanSkillDependencyUsage(root, assetId)).rejects.toMatchObject({ status: 503 });
    });
});
