import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export interface HelpArticle { slug: string; title: string; summary: string; content: string; revision: string; updatedAt: string }
const maximum = 512 * 1024;
export const helpSlug = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value)) throw new BadRequestException('Адрес статьи: латинские буквы, цифры и дефис, до 80 знаков.');
    return value;
};
const absent = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const writers = new Map<string, Promise<void>>();
/** A crashed process cannot leave this queue locked; cross-process HTTP writers use a PG transaction lock. */
async function writeLocally<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = writers.get(key) || Promise.resolve(); let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; }), waiting = previous.then(() => done); writers.set(key, waiting);
    await previous;
    try { return await run(); } finally { release(); if (writers.get(key) === waiting) writers.delete(key); }
}

/** Markdown files are authoritative; every request observes external edits without a rebuild. */
export class HelpFiles {
    constructor(readonly directory = path.resolve(process.env.HELP_CONTENT_DIR || path.join(__dirname, '../../content/help'))) {}
    private async root(): Promise<void> {
        try { const stat = await lstat(this.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-root'); }
        catch { throw new ServiceUnavailableException('Каталог статей недоступен. Проверьте HELP_CONTENT_DIR.'); }
    }
    async read(slug: string): Promise<HelpArticle> {
        helpSlug(slug); await this.root(); const file = path.join(this.directory, slug + '.md');
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
            handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            const before = await handle.stat();
            if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new BadRequestException('Статья должна быть обычным .md файлом размером до 512 КиБ.');
            const bytes = await handle.readFile(); const after = await handle.stat();
            if (bytes.length > maximum || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new ConflictException('Статья изменяется. Повторите чтение.');
            const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            const title = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(content.replace(/^\uFEFF/, ''))?.[1]?.trim() || slug;
            const summary = content.split(/\r?\n\s*\r?\n/).find(part => part.trim() && !part.trim().startsWith('#'))?.replace(/[`*_\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240) || '';
            return { slug, title, summary, content, revision: digest(bytes), updatedAt: after.mtime.toISOString() };
        } catch (error) {
            if (absent(error)) throw new NotFoundException('Статья не найдена.');
            if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
            throw new ServiceUnavailableException('Не удалось прочитать безопасный UTF-8 файл статьи.');
        } finally { await handle?.close(); }
    }
    async list(): Promise<Array<Omit<HelpArticle, 'content'>>> {
        await this.root(); const entries = await readdir(this.directory, { withFileTypes: true });
        const files = entries.filter(item => item.isFile() && /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?\.md$/.test(item.name));
        if (files.length > 500) throw new ServiceUnavailableException('В разделе помощи больше 500 статей. Разделите каталог.');
        const result: Array<Omit<HelpArticle, 'content'>> = [];
        for (const item of files) { const { content: _content, ...article } = await this.read(item.name.slice(0, -3)); result.push(article); }
        return result.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    }
    /** Expected SHA protects drafts from external edits; the caller serializes remote UI writers. */
    async save(slug: string, content: unknown, expectedRevision: unknown): Promise<HelpArticle> {
        helpSlug(slug); await this.root();
        if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > maximum || content.includes('\0') || !/^#[ \t]+\S/m.test(content.replace(/^\uFEFF/, ''))) throw new BadRequestException('Добавьте заголовок # и текст статьи в UTF-8, до 512 КиБ.');
        if (new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.from(content)) !== content) throw new BadRequestException('Текст статьи должен содержать корректные символы UTF-8.');
        if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))) throw new BadRequestException('Передайте исходную ревизию статьи.');
        return writeLocally(path.join(this.directory, slug + '.md'), () => this.publish(slug, content, expectedRevision));
    }
    private async publish(slug: string, content: string, expectedRevision: unknown): Promise<HelpArticle> {
        const temporary = path.join(this.directory, '.' + slug + '.' + randomUUID() + '.tmp'); let created = false;
        try {
            let current: HelpArticle | undefined;
            try { current = await this.read(slug); } catch (error) { if (!(error instanceof NotFoundException)) throw error; }
            if ((current?.revision ?? null) !== expectedRevision) throw new ConflictException('Статья уже изменена. Ваш текст сохранён в редакторе; сравните с актуальной версией.');
            const output = await open(temporary, 'wx', 0o600); created = true;
            try { await output.writeFile(content, 'utf8'); await output.sync(); } finally { await output.close(); }
            let latest: HelpArticle | undefined;
            try { latest = await this.read(slug); } catch (error) { if (!(error instanceof NotFoundException)) throw error; }
            if ((latest?.revision ?? null) !== expectedRevision) throw new ConflictException('Файл статьи изменён другим редактором. Сравните версии.');
            await rename(temporary, path.join(this.directory, slug + '.md')); created = false;
            const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
            return this.read(slug);
        } finally {
            if (created) await unlink(temporary).catch(() => undefined);
        }
    }
}
