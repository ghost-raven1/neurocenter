import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { HelpFiles, helpSlug } from '../src/help/help-files';

describe('Help Markdown source files', () => {
    let directory: string, files: HelpFiles;
    beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-help-')); files = new HelpFiles(directory); });
    afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
    it('reads an external .md edit immediately and derives article metadata from the same bytes', async () => {
        await writeFile(path.join(directory, 'bridge.md'), '# Мост\n\nНачальная статья.\n');
        const old = await files.read('bridge'); expect(old.title).toBe('Мост'); expect(old.summary).toBe('Начальная статья.');
        await writeFile(path.join(directory, 'bridge.md'), '# Подключение\n\nОбновлено снаружи.\n');
        const next = await files.read('bridge'); expect(next.title).toBe('Подключение'); expect(next.revision).not.toBe(old.revision);
        expect(await files.list()).toEqual([{ slug: 'bridge', title: 'Подключение', summary: 'Обновлено снаружи.', revision: next.revision, updatedAt: next.updatedAt }]);
    });
    it('creates then updates exactly the Markdown bytes while rejecting stale drafts', async () => {
        const created = await files.save('start', '# Начало\n\nПервая версия.\n', null);
        const next = await files.save('start', '# Начало\r\n\r\nВторая версия.\r\n', created.revision);
        expect(await readFile(path.join(directory, 'start.md'), 'utf8')).toBe(next.content);
        await expect(files.save('start', '# Устаревшее\n', created.revision)).rejects.toMatchObject({ status: 409 });
        expect((await files.read('start')).content).toBe(next.content);
        await expect(files.save('start', '# Повторное создание\n', null)).rejects.toMatchObject({ status: 409 });
    });
    it('preserves a UTF-8 BOM and computes revision from the actual file bytes', async () => {
        const content = '\uFEFF# Статья\r\n\r\nТекст.\r\n'; await writeFile(path.join(directory, 'bom.md'), content);
        const article = await files.read('bom'); expect(article.title).toBe('Статья'); expect(article.content).toBe(content);
        expect(article.revision).toBe(createHash('sha256').update(Buffer.from(content)).digest('hex'));
        const saved = await files.save('bom', content + 'Ещё.\r\n', article.revision); expect(await readFile(path.join(directory, 'bom.md'), 'utf8')).toBe(saved.content);
    });
    it('serializes competing editors: only one draft from the same revision is published', async () => {
        const first = await files.save('start', '# Исходная\n', null);
        const result = await Promise.allSettled([files.save('start', '# Редактор один\n', first.revision), files.save('start', '# Редактор два\n', first.revision)]);
        expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
        const saved = result.find(item => item.status === 'fulfilled'); expect((await files.read('start')).content).toBe(saved?.status === 'fulfilled' ? saved.value.content : 'unexpected');
    });
    it('does not follow symlinks or modify their target during an admin save', async () => {
        const outside = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-help-outside-'));
        try {
            const target = path.join(outside, 'private.md'); await writeFile(target, '# Private\n'); await symlink(target, path.join(directory, 'unsafe.md'));
            await expect(files.read('unsafe')).rejects.toMatchObject({ status: 503 });
            await expect(files.save('unsafe', '# Replacement\n', null)).rejects.toMatchObject({ status: 503 });
            expect(await readFile(target, 'utf8')).toBe('# Private\n');
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
    it('rejects hardlinks, binary UTF-8 and oversized files before returning content', async () => {
        await writeFile(path.join(directory, 'first.md'), '# First\n'); await link(path.join(directory, 'first.md'), path.join(directory, 'hard.md'));
        await expect(files.read('hard')).rejects.toMatchObject({ status: 400 });
        await writeFile(path.join(directory, 'binary.md'), Buffer.from([0xff])); await expect(files.read('binary')).rejects.toMatchObject({ status: 503 });
        await writeFile(path.join(directory, 'large.md'), 'a'.repeat(512 * 1024 + 1)); await expect(files.read('large')).rejects.toMatchObject({ status: 400 });
    });
    it.each(['../secret', 'one/two', 'a.md', '/absolute', 'bad%2fslug', '', '-bad', 'bad-', 'a'.repeat(81)])('rejects unsafe article slug %s', value => { expect(() => helpSlug(value)).toThrow(); });
    it('does not let a stale file lock from a crashed old writer block a new save', async () => {
        const first = await files.save('start', '# First\n', null); await writeFile(path.join(directory, '.start.lock'), 'owned');
        await files.save('start', '# Second\n', first.revision);
        expect((await files.read('start')).content).toBe('# Second\n'); expect(await readFile(path.join(directory, '.start.lock'), 'utf8')).toBe('owned');
    });
    it('ignores non-article filenames without making the valid Markdown list unavailable', async () => {
        await files.save('start', '# Начало\n', null);
        for (const name of ['invalid-.md', 'a'.repeat(81) + '.md', 'notes.txt']) await writeFile(path.join(directory, name), '# Not an article\n');
        expect((await files.list()).map(article => article.slug)).toEqual(['start']);
    });
});
