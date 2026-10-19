import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { Header } from 'tar';
import { readSourceArchive } from '../src/package-build/source-archive';

interface FixtureFile {path: string; content?: string | Buffer; type?: string; link?: string; mode?: number; encrypted?: boolean; crc?: number; utf8?: boolean; nameBytes?: Buffer}
const crc32 = (zlib as typeof zlib & {crc32(bytes: Buffer): number}).crc32;
const request = (name: string, bytes: Buffer) => ({name, contentBase64: bytes.toString('base64')});
function tar(files: FixtureFile[]): Buffer {
    const blocks: Buffer[] = [];
    for (const file of files) {
        const bytes = Buffer.from(file.content ?? '');
        const header = new Header({path: file.path, size: bytes.length, type: (file.type ?? 'File') as Header['type'], mode: file.mode ?? 0o644, linkpath: file.link});
        header.encode();
        blocks.push(header.block!, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function zip(files: FixtureFile[]): Buffer {
    const records: Buffer[] = [], directory: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
        const name = file.nameBytes ?? Buffer.from(file.path), bytes = Buffer.from(file.content ?? ''), compressed = zlib.deflateRawSync(bytes);
        const local = Buffer.alloc(30), central = Buffer.alloc(46), flag = (file.utf8 === false ? 0 : 0x800) | (file.encrypted ? 1 : 0), checksum = file.crc ?? crc32(bytes);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flag, 6); local.writeUInt16LE(8, 8);
        local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
        central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flag, 8); central.writeUInt16LE(8, 10);
        central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((file.mode ?? (file.path.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
        records.push(local, name, compressed); directory.push(central, name); offset += local.length + name.length + compressed.length;
    }
    const end = Buffer.alloc(22), directoryBytes = Buffer.concat(directory);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...records, directoryBytes, end]);
}
const source = [{path: 'tool/package.json', content: '{"name":"archive-tool","main":"src/index.ts"}'}, {path: 'tool/src/index.ts', content: 'export default () => ({})'}];
function paxPath(value: string): string {
    const body = ' path=' + value + '\n';
    let size = Buffer.byteLength(body) + 1;
    while (String(size).length + Buffer.byteLength(body) !== size) {size = String(size).length + Buffer.byteLength(body);}
    return size + body;
}

describe('Предварительное чтение архивов исходников', () => {
    it.each(['zip', 'tar', 'tar.gz', 'tgz'])('Читает %s с единым корнем в общий источник files', async extension => {
        const bytes = extension === 'zip' ? zip(source) : extension === 'tar' ? tar(source) : zlib.gzipSync(tar(source));
        await expect(readSourceArchive(request('tool.' + extension, bytes))).resolves.toEqual({rootName: 'tool', skipped: 0,
            files: [{path: 'package.json', content: source[0].content}, {path: 'src/index.ts', content: source[1].content}]});
    });
    it('Сохраняет корневые файлы и не снимает одну из нескольких папок', async () => {
        const files = [{path: 'src/index.ts', content: 'one'}, {path: 'package.json', content: '{}'}, {path: 'other/value.ts', content: 'two'}];
        await expect(readSourceArchive(request('tool.zip', zip(files)))).resolves.toEqual({files: files.map(({path, content}) => ({path, content})), skipped: 0});
    });
    it('Понимает macOS PAX-путь и пропускает служебные файлы и секреты перед UTF-8', async () => {
        const files: FixtureFile[] = [{path: './', type: 'Directory'},
            {path: 'PaxHeaders/index.ts', type: 'ExtendedHeader', content: paxPath('tool/src/index.ts')}, {path: 'placeholder', content: 'export default 1;'},
            {path: 'tool/.DS_Store', content: Buffer.from([0, 255])}, {path: 'tool/._index.ts', content: Buffer.from([0, 255])},
            {path: 'tool/.env', content: 'private'}, {path: 'tool/.npmrc', content: 'private'}, {path: 'tool/.yarnrc.yml', content: 'private'}];
        await expect(readSourceArchive(request('tool.tar.gz', zlib.gzipSync(tar(files))))).resolves.toEqual({rootName: 'tool', skipped: 5,
            files: [{path: 'src/index.ts', content: 'export default 1;'}]});
    });
    it('Не считает __MACOSX вторым корнем ZIP и не возвращает метаданные', async () => {
        const bytes = zip([...source, {path: '__MACOSX/._tool', content: Buffer.from([0, 255])}]);
        await expect(readSourceArchive(request('tool.zip', bytes))).resolves.toMatchObject({rootName: 'tool', skipped: 1});
    });
    it('Пропускает AppleDouble корня обычного macOS TAR, сохраняя проверки путей и размеров', async () => {
        const files = [{path: '._.', content: Buffer.from([0, 255])}, ...source];
        await expect(readSourceArchive(request('tool.tar', tar(files)))).resolves.toMatchObject({rootName: 'tool', skipped: 1, files: expect.arrayContaining([{path: 'src/index.ts', content: source[1].content}])});
        for (const path of ['../._.', 'bad /._.', 'CON/._.']) {
            await expect(readSourceArchive(request('bad.tar', tar([{path, content: 'x'}, ...source])))).rejects.toThrow('небезопасный');
        }
        await expect(readSourceArchive(request('large.tar.gz', zlib.gzipSync(tar([{path: '._.', content: Buffer.alloc(1024 * 1024 + 1)}, ...source]))))).rejects.toThrow('1 МиБ');
        await expect(readSourceArchive(request('directory.tar', tar([{path: '._./', type: 'Directory'}, ...source])))).rejects.toThrow('небезопасный');
    });
    it.each(['build', 'dist', 'node_modules'])('Снимает внешнюю папку %s перед исключением зависимостей и результатов сборки', async root => {
        const files = source.map(file => ({...file, path: file.path.replace(/^tool\//, root + '/')}));
        files.push({path: root + '/.env', content: 'private'}, {path: root + '/node_modules/dependency/index.js', content: 'dependency'});
        const entries = [...files, {path: '__MACOSX/._' + root, content: 'metadata'}];
        for (const [name, bytes] of [['tool.zip', zip(entries)], ['tool.tar.gz', zlib.gzipSync(tar(entries))]] as const) {
            await expect(readSourceArchive(request(name, bytes))).resolves.toMatchObject({rootName: root, skipped: 3,
                files: [{path: 'package.json', content: source[0].content}, {path: 'src/index.ts', content: source[1].content}]});
        }
    });
    it('Не открывает исключённую папку секретов как корень и сохраняет внешние исключения', async () => {
        await expect(readSourceArchive(request('private.zip', zip([{path: '.git/config', content: 'private'}])))).rejects.toThrow('нет подходящих');
        await expect(readSourceArchive(request('tool.zip', zip([...source, {path: '.env', content: 'private'}, {path: 'node_modules/lib/index.js', content: 'dependency'}])))).resolves.toMatchObject({rootName: 'tool', skipped: 2, files: expect.arrayContaining([{path: 'src/index.ts', content: source[1].content}])});
    });
    it('Сохраняет UTF-8 имена ZIP от macOS без флага и legacy CP437', async () => {
        const files = [{path: 'tool/日本語.ts', content: 'one', utf8: false},
            {path: 'tool/café.ts', content: 'two', utf8: false, nameBytes: Buffer.from([116, 111, 111, 108, 47, 99, 97, 102, 130, 46, 116, 115])}];
        await expect(readSourceArchive(request('tool.zip', zip(files)))).resolves.toMatchObject({rootName: 'tool', files: [{path: '日本語.ts', content: 'one'}, {path: 'café.ts', content: 'two'}]});
        await expect(readSourceArchive(request('bad.zip', zip([{path: 'bad.ts', content: 'x', nameBytes: Buffer.from([255, 46, 116, 115])}])))).rejects.toThrow('UTF-8');
    });
    it.each(['../escape.ts', '/absolute.ts', 'tool/../escape.ts', 'tool/a\\b.ts', 'tool/CON.ts', 'tool/a:stream'])('Отклоняет опасный путь %s до фильтрации', async path => {
        for (const bytes of [tar([{path: 'tool/.git/' + path, content: 'x'}]), zip([{path: 'tool/.git/' + path, content: 'x'}])]) {
            await expect(readSourceArchive(request(bytes.readUInt32LE() === 0x04034b50 ? 'bad.zip' : 'bad.tar', bytes))).rejects.toThrow();
        }
    });
    it.each([
        ['tool/index.ts', 'tool/INDEX.ts'], ['tool/é.ts', 'tool/e\u0301.ts'], ['tool/index.ts', 'tool/index.ts/child.ts'],
    ])('Не допускает повторы и конфликты путей %s и %s', async (first, second) => {
        const files = [{path: first, content: 'one'}, {path: second, content: 'two'}];
        await expect(readSourceArchive(request('bad.tar', tar(files)))).rejects.toThrow('конфликтуют');
        await expect(readSourceArchive(request('bad.zip', zip(files)))).rejects.toThrow('конфликтуют');
    });
    it.each(['SymbolicLink', 'Link', 'FIFO', 'CharacterDevice'])('Отклоняет TAR %s даже внутри исключаемой папки', async type => {
        await expect(readSourceArchive(request('bad.tar', tar([{path: 'tool/.git/link', type, link: ['Link', 'SymbolicLink'].includes(type) ? '../private' : undefined}])))).rejects.toThrow();
    });
    it.each([{mode: 0o120777}, {encrypted: true}, {mode: 0o020644}])('Отклоняет ссылку, шифрование или специальную запись ZIP: %j', async extra => {
        await expect(readSourceArchive(request('bad.zip', zip([{path: 'tool/.git/link', content: 'private', ...extra}])))).rejects.toThrow();
    });
    it('Отклоняет неверные UTF-8, NUL и CRC обычных файлов', async () => {
        for (const content of [Buffer.from([0xff]), Buffer.from('with\0zero')]) {
            await expect(readSourceArchive(request('bad.zip', zip([{path: 'index.ts', content}])))).rejects.toThrow();
        }
        await expect(readSourceArchive(request('bad.zip', zip([{path: 'index.ts', content: 'export default 1', crc: 42}])))).rejects.toThrow('CRC');
    });
    it('Считает размеры исключаемых зависимостей и не распаковывает ZIP-bomb', async () => {
        const files = [{path: 'index.ts', content: 'ok'}, {path: 'node_modules/huge', content: Buffer.alloc(1024 * 1024 + 1)}];
        await expect(readSourceArchive(request('bomb.zip', zip(files)))).rejects.toThrow('1 МиБ');
        await expect(readSourceArchive(request('bomb.tar.gz', zlib.gzipSync(tar(files))))).rejects.toThrow('1 МиБ');
        const total = Array.from({length: 6}, (_, index) => ({path: 'node_modules/' + index, content: Buffer.alloc(1024 * 1024)}));
        await expect(readSourceArchive(request('total.zip', zip(total)))).rejects.toThrow('5 МиБ');
    });
    it('Ограничивает весь распакованный TAR, включая нулевой хвост и метаданные', async () => {
        const bomb = zlib.gzipSync(Buffer.concat([tar(source), Buffer.alloc(11 * 1024 * 1024)]));
        await expect(readSourceArchive(request('bomb.tar.gz', bomb))).rejects.toThrow('допустимый размер');
    });
    it('Ограничивает число файлов и число всех TAR/ZIP-записей', async () => {
        const tooMany = Array.from({length: 101}, (_, i) => ({path: 'tool/' + i + '.ts', content: 'x'}));
        await expect(readSourceArchive(request('files.zip', zip(tooMany)))).rejects.toThrow('100 текстовых');
        const directories = Array.from({length: 1001}, (_, i) => ({path: 'dir' + i + '/', type: 'Directory'}));
        await expect(readSourceArchive(request('entries.zip', zip(directories)))).rejects.toThrow('1000');
        await expect(readSourceArchive(request('entries.tar', tar(directories)))).rejects.toThrow('1000');
    });
    it('Отклоняет обрыв, неверный checksum и данные после окончания TAR', async () => {
        const bytes = tar(source), broken = Buffer.from(bytes); broken[100] ^= 1;
        for (const invalid of [bytes.subarray(0, bytes.length - 512), broken, Buffer.concat([bytes, tar(source)])]) {
            await expect(readSourceArchive(request('bad.tar', invalid))).rejects.toThrow();
        }
        await expect(readSourceArchive(request('bad.zip', zip(source).subarray(0, 60)))).rejects.toThrow();
        await expect(readSourceArchive(request('bad.tar.gz', zlib.gzipSync(bytes).subarray(0, 30)))).rejects.toThrow();
    });
    it('Не принимает лишние поля, неоднозначный base64, неверный формат и архив больше 8 МиБ', async () => {
        for (const input of [{...request('tool.zip', zip(source)), command: 'run'}, {name: 'tool.zip', contentBase64: 'YQ= '},
            request('tool.rar', tar(source)), request('../tool.zip', zip(source)), request('large.tar', Buffer.alloc(8 * 1024 * 1024 + 1))]) {
            await expect(readSourceArchive(input)).rejects.toThrow();
        }
    });
    it('Проверяет base64 на границе 8 МиБ без переполнения стека регулярного выражения', async () => {
        await expect(readSourceArchive(request('large.tar', Buffer.alloc(8 * 1024 * 1024)))).rejects.toThrow(BadRequestException);
    });
    it('Таймаут закрывает ZIP и уничтожает зависший поток без фоновых ошибок', async () => {
        const active = new Readable({read() {}});
        const zipFile = Object.assign(new EventEmitter(), {
            close: vi.fn(), openReadStreamPromise: vi.fn().mockResolvedValue(active),
            readEntry() {queueMicrotask(() => this.emit('entry', {fileName: 'index.ts', fileNameRaw: Buffer.from('index.ts'), uncompressedSize: 1, externalFileAttributes: 0, generalPurposeBitFlag: 0, crc32: 0}));},
        });
        const mocked = vi.spyOn(require('yauzl'), 'fromBufferPromise').mockResolvedValue(zipFile);
        vi.useFakeTimers();
        try {
            const result = expect(readSourceArchive(request('slow.zip', zip(source)))).rejects.toThrow('слишком много времени');
            await vi.advanceTimersByTimeAsync(10001);
            await result;
            expect(active.destroyed).toBe(true);
            expect(zipFile.close).toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {mocked.mockRestore(); vi.useRealTimers();}
    });
});
