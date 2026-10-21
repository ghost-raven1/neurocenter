import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { Header, Parser, type ReadEntry } from 'tar';
import { portablePath } from '../../../shared/runtime-artifacts.cjs';
import { MAX_PACKAGE_BYTES, object, packageFiles,filePath } from '../publication/publication-validation';

interface SourceFile {path: string; content: string;encoding?:'base64'}
interface ArchiveEntry {path: string; directory: boolean; content?: Buffer}
interface ZipEntry {fileName: string; fileNameRaw: Buffer; uncompressedSize: number; externalFileAttributes: number; generalPurposeBitFlag: number; crc32: number}
interface ZipArchive {
    on(event: string, listener: (...args: never[]) => void): this;
    readEntry(): void;
    openReadStreamPromise(entry: ZipEntry): Promise<Readable>;
    close(): void;
}
const yauzl = require('yauzl') as {fromBufferPromise(bytes: Buffer, options: Record<string, boolean>): Promise<ZipArchive>};
const crc32 = (zlib as typeof zlib & {crc32(bytes: Buffer, previous?: number): number}).crc32;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024, MAX_TAR_BYTES = 10 * 1024 * 1024, MAX_FILE_BYTES = 1024 * 1024;
function fail(message: string): never {throw new BadRequestException(message);}
const macMetadata = (part: string): boolean => ['__macosx', '.ds_store'].includes(part.toLowerCase()) || part.startsWith('._');
const pythonNoise = (parts:string[]):boolean => parts.some(part=>['.venv','venv','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache'].includes(part.toLowerCase())||/\.py[co]$/i.test(part));
const pythonText = (name:string):boolean => /(?:\.py|\.toml|(?:^|\/)requirements(?:[._-][^/]*)?\.(?:txt|in))$/i.test(name);
const ignored = (parts: string[],skill=false,python=false): boolean => python&&pythonNoise(parts)||parts.some(raw => {
    const part = raw.toLowerCase();
    return ['.git', 'node_modules', '.npmrc', '.yarnrc', '.yarnrc.yml',...skill?[]:['dist','build']].includes(part)
        || macMetadata(part) || /^\.env(?:\.|$)/.test(part) || /^(?:id_rsa|id_ed25519)(?:\.|$)/.test(part) || /\.(?:pem|key)$/.test(part);
});

class ArchiveContents {
    readonly entries: ArchiveEntry[] = [];
    private readonly names = new Map<string, boolean>();
    private readonly parents = new Set<string>();
    private bytes = 0;

    add(name: string, size: number, directory: boolean): ArchiveEntry {
        const clean = name.replace(/^(?:\.\/)+/, '');
        const relative = directory ? clean.replace(/\/$/, '') : clean;
        if (!relative && directory && /^(?:\.\/)*$/.test(name)) {return {path: '', directory};}
        // bsdtar добавляет ._. для метаданных корня; родительские пути всё равно проверяются.
        const checkedPath = !directory ? relative.replace(/(^|\/)\._\.$/, '$1._root') : relative;
        if (!portablePath(checkedPath) || !Number.isSafeInteger(size) || size < 0 || directory && size !== 0) {fail('В архиве найден небезопасный путь или размер.');}
        const key = relative.normalize('NFC').toLowerCase();
        const ancestors = key.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
        if (this.names.has(key) || !directory && this.parents.has(key) || ancestors.some(parent => this.names.get(parent) === false)) {
            fail('В архиве повторяются или конфликтуют пути файлов.');
        }
        this.names.set(key, directory);
        ancestors.forEach(parent => this.parents.add(parent));
        if (!directory) {this.bytes += size;}
        if (size > MAX_FILE_BYTES || this.bytes > MAX_PACKAGE_BYTES) {fail('Лимит архива: 1 МиБ на файл и 5 МиБ всех исходников, включая пропускаемые файлы.');}
        const entry = {path: relative, directory};
        this.entries.push(entry);
        return entry;
    }

    result(): {files: SourceFile[]; skipped: number; rootName?: string} {
        const files = this.entries.filter(entry => !entry.directory);
        const relevant = files.filter(entry => !ignored(entry.path.split('/')));
        const commonRoot = (entries: ArchiveEntry[]): string | undefined => {
            const root = entries[0]?.path.split('/')[0];
            return root && entries.every(entry => entry.path.startsWith(root + '/')) ? root : undefined;
        };
        const wrapper = commonRoot(files.filter(entry => !entry.path.split('/').some(macMetadata)));
        // Имя внешней папки build/dist не делает весь проект результатом сборки.
        const rootName = wrapper && (!ignored([wrapper]) || ['build', 'dist', 'node_modules'].includes(wrapper.toLowerCase())) ? wrapper : commonRoot(relevant);
        const relativeParts=(entry:ArchiveEntry):string[]=>entry.path.split('/').slice(rootName&&entry.path.startsWith(rootName+'/')?1:0);
        const skill=files.some(entry=>{const parts=relativeParts(entry);return parts[parts.length-1]==='SKILL.md'&&!ignored(parts,true,true);});
        const python=!skill&&files.some(entry=>{const parts=relativeParts(entry);return parts[parts.length-1]?.endsWith('.py')&&!ignored(parts)&&!pythonNoise(parts);});
        const accepted: SourceFile[] = [];
        let skipped = 0;
        for (const entry of files) {
            const parts = relativeParts(entry);
            if (ignored(parts,skill,python)) {skipped++; continue;}
            let content: string;
            let encoding:'base64'|undefined;
            try {content = new TextDecoder('utf-8', {fatal: true,ignoreBOM:true}).decode(entry.content!);if(content.includes('\0'))throw new Error();}
            catch {
                if(!(python&&!pythonText(parts.join('/')))&&(!skill||!/(?:^|\/)(?:scripts|references|assets)\//.test(parts.join('/'))))fail('В архиве нужны текстовые исходники UTF-8: '+parts.join('/'));
                content=entry.content!.toString('base64');encoding='base64';
            }
            accepted.push({path: parts.join('/'), content,...(encoding?{encoding}:{})});
        }
        if (!accepted.length) {fail('В архиве нет подходящих текстовых исходников.');}
        if((skill||python)&&accepted.length>100)fail('Допустимо до 100 файлов исходников.');
        // Archive limits already cover original binary sizes; text files keep the existing publication validation.
        if(python)packageFiles(accepted.filter(file=>!file.encoding));
        return {files:skill||python?accepted.map(file=>({...file,path:filePath(file.path)})):packageFiles(accepted).map(({path, content}) => ({path, content: content!})), skipped, ...(rootName ? {rootName} : {})};
    }
}

async function readBounded(stream: Readable, limit: number, signal: AbortSignal): Promise<Buffer> {
    const abort = (): void => {stream.destroy(signal.reason as Error);};
    signal.addEventListener('abort', abort, {once: true});
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
        signal.throwIfAborted();
        for await (const chunk of stream) {
            signal.throwIfAborted();
            bytes += chunk.length;
            if (bytes > limit) {fail('Распакованный архив превышает допустимый размер.');}
            chunks.push(chunk);
        }
        return Buffer.concat(chunks, bytes);
    } finally {signal.removeEventListener('abort', abort); stream.destroy();}
}

/** Библиотечные заголовки считают также PAX и проверяют конец TAR до разбора содержимого. */
function checkTar(bytes: Buffer): void {
    let offset = 0, count = 0;
    while (offset + 512 <= bytes.length) {
        const header = new Header(bytes, offset);
        if (header.nullBlock) {
            if (offset + 1024 > bytes.length || bytes.length % 512 || bytes.subarray(offset).some(byte => byte !== 0)) {fail('Повреждено окончание TAR или после него есть данные.');}
            return;
        }
        if (!header.cksumValid || !Number.isSafeInteger(header.size) || header.size! < 0) {fail('Повреждён заголовок TAR.');}
        if (++count > 1000) {fail('В архиве допустимо до 1000 записей.');}
        offset += 512 + Math.ceil(header.size! / 512) * 512;
        if (!Number.isSafeInteger(offset) || offset > bytes.length) {fail('Архив TAR оборван.');}
    }
    fail('Архив TAR оборван: отсутствует окончание.');
}

async function readTar(bytes: Buffer, contents: ArchiveContents, signal: AbortSignal): Promise<void> {
    checkTar(bytes);
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const parser = new Parser({strict: true, maxMetaEntrySize: 16 * 1024});
        const abort = (): void => parser.abort(signal.reason as Error);
        const stop = (error?: Error): void => {
            if (settled) {return;}
            settled = true; signal.removeEventListener('abort', abort);
            if (error) {reject(error);} else {resolve();}
        };
        parser.on('error', stop);
        parser.on('ignoredEntry', () => {parser.abort(new BadRequestException('Специальные записи или слишком большие метаданные TAR запрещены.'));});
        parser.on('entry', (entry: ReadEntry) => {
            try {
                signal.throwIfAborted();
                if (!['File', 'Directory'].includes(entry.type) || entry.linkpath) {fail('Ссылки и специальные записи TAR запрещены.');}
                const file = contents.add(entry.path, entry.size, entry.type === 'Directory');
                const chunks: Buffer[] = [];
                let size = 0;
                entry.on('error', error => parser.abort(error as Error));
                entry.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > entry.size || size > MAX_FILE_BYTES) {parser.abort(new BadRequestException('Файл TAR превышает заявленный размер.')); return;}
                    chunks.push(chunk);
                });
                entry.on('end', () => {
                    if (size !== entry.size) {parser.abort(new BadRequestException('Файл TAR оборван.')); return;}
                    file.content = Buffer.concat(chunks, size);
                });
                entry.resume();
            } catch (error) {parser.abort(error as Error);}
        });
        parser.on('end', () => stop());
        signal.addEventListener('abort', abort, {once: true});
        try {signal.throwIfAborted(); parser.end(bytes);} catch (error) {stop(error as Error);}
    });
}

async function readZip(bytes: Buffer, contents: ArchiveContents, signal: AbortSignal): Promise<void> {
    const zip = await yauzl.fromBufferPromise(bytes, {lazyEntries: true, strictFileNames: true, validateEntrySizes: true});
    let active: Readable | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false, count = 0;
            const abort = (): void => stop(signal.reason as Error);
            const stop = (error?: Error): void => {
                if (settled) {return;}
                settled = true; signal.removeEventListener('abort', abort); active?.destroy(); zip.close();
                if (error) {reject(error);} else {resolve();}
            };
            zip.on('error', stop);
            zip.on('end', () => stop());
            zip.on('entry', (entry: ZipEntry) => {
                void (async () => {
                    signal.throwIfAborted();
                    if (++count > 1000) {fail('В архиве допустимо до 1000 записей.');}
                    // macOS ditto сохраняет UTF-8 имена без флага; legacy CP437 остаётся запасным вариантом.
                    let name = entry.fileName;
                    try {
                        const utf8 = new TextDecoder('utf-8', {fatal: true}).decode(entry.fileNameRaw);
                        if (entry.generalPurposeBitFlag & 0x800 || entry.fileNameRaw.some(byte => byte > 127)) {name = utf8;}
                    } catch {if (entry.generalPurposeBitFlag & 0x800) {fail('Путь ZIP должен быть корректным UTF-8.');}}
                    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
                    const directory = name.endsWith('/');
                    if (entry.generalPurposeBitFlag & 1 || mode && mode !== (directory ? 0o040000 : 0o100000)) {fail('Ссылки, специальные и зашифрованные ZIP-файлы запрещены.');}
                    const file = contents.add(name, entry.uncompressedSize, directory);
                    if (!directory) {
                        active = await zip.openReadStreamPromise(entry);
                        if (settled) {active.destroy(); return;}
                        file.content = await readBounded(active, Math.min(MAX_FILE_BYTES, entry.uncompressedSize), signal);
                        active = undefined;
                        if (file.content.length !== entry.uncompressedSize || crc32(file.content) !== entry.crc32) {fail('ZIP-файл повреждён: размер или CRC не совпадает.');}
                    }
                    if (!settled) {zip.readEntry();}
                })().catch(stop);
            });
            signal.addEventListener('abort', abort, {once: true});
            if (signal.aborted) {abort();} else {zip.readEntry();}
        });
    } finally {active?.destroy(); zip.close();}
}

/** Только preview: архив превращается в обычные исходники без записи диска или запуска кода. */
export async function readSourceArchive(raw: unknown): Promise<{files: SourceFile[]; skipped: number; rootName?: string}> {
    const input = object(raw, 'Архив');
    if (Object.keys(input).some(key => !['name', 'contentBase64'].includes(key)) || typeof input.name !== 'string'
        || !input.name || input.name.length > 256 || /[\\/\x00-\x1f\x7f]/.test(input.name) || !/\.(?:zip|tar|tar\.gz|tgz)$/i.test(input.name)) {fail('Выберите архив ZIP, TAR, TAR.GZ или TGZ.');}
    if (typeof input.contentBase64 !== 'string' || !input.contentBase64 || input.contentBase64.length > 4 * Math.ceil(MAX_ARCHIVE_BYTES / 3)
        || input.contentBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(input.contentBase64)) {fail('Архив должен быть корректным base64 размером до 8 МиБ.');}
    const bytes = Buffer.from(input.contentBase64, 'base64');
    if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES || bytes.toString('base64') !== input.contentBase64) {fail('Архив должен быть корректным base64 размером до 8 МиБ.');}
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new BadRequestException('Проверка архива заняла слишком много времени.')), 10000);
    timer.unref();
    try {
        const contents = new ArchiveContents();
        if (/\.zip$/i.test(input.name)) {await readZip(bytes, contents, controller.signal);}
        else {
            const compressed = /\.(?:tar\.gz|tgz)$/i.test(input.name);
            if (compressed && !bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) {fail('В TAR.GZ нужен архив сжатия gzip.');}
            const tar = compressed ? await readBounded(Readable.from([bytes]).pipe(zlib.createGunzip()), MAX_TAR_BYTES, controller.signal) : bytes;
            // Предварительная проверка TAR исключает повторное сжатие и автоматическое распознавание другого формата.
            await readTar(tar, contents, controller.signal);
        }
        return contents.result();
    } catch (error) {
        if (error instanceof BadRequestException) {throw error;}
        throw new BadRequestException('Архив повреждён или имеет неподдерживаемый формат.');
    } finally {clearTimeout(timer);}
}
