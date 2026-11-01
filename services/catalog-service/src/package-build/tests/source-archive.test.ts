import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { readSourceArchive } from '../source-archive';

const MiB = 1024 * 1024;
const limitMessage = 'Лимит архива: 1 МиБ на файл и 5 МиБ всех исходников, включая пропускаемые файлы.';

/** Build owned TAR bytes in memory; all validation is performed by the real archive reader. */
function tar(entries: { path: string; content?: Buffer; linkpath?: string }[]): Buffer {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        const content = entry.content ?? Buffer.alloc(0);
        const header = Buffer.alloc(512);
        new Header({
            path: entry.path,
            mode: 0o644,
            size: content.length,
            type: entry.linkpath ? 'SymbolicLink' : 'File',
            ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        }).encode(header);
        blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }
    return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function read(bytes: Buffer, compressed = false) {
    return readSourceArchive({
        name: compressed ? 'source.tar.gz' : 'source.tar',
        contentBase64: (compressed ? gzipSync(bytes) : bytes).toString('base64'),
    });
}

const source = { path: 'project/index.ts', content: Buffer.from('export const ready = true;\n') };

/** Zero TAR padding changes container size without changing the source-file budget. */
function padded(bytes: Buffer, size: number): Buffer {
    return Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
}

describe('Source archive preview limits and path safety', () => {
    it.each([false, true])('accepts exactly 1 MiB and returns the source bytes (gzip=%s)', async (compressed) => {
        const content = Buffer.alloc(MiB, 'x');
        await expect(read(tar([{ path: source.path, content }]), compressed)).resolves.toEqual({
            files: [{ path: 'index.ts', content: content.toString() }],
            skipped: 0,
            rootName: 'project',
        });
    });

    it.each(['project/index.ts', 'project/node_modules/ignored.js'])(
        'rejects a file over 1 MiB before filtering %s',
        async (path) => {
            await expect(read(tar([{ path, content: Buffer.alloc(MiB + 1, 'x') }]))).rejects.toMatchObject({
                status: 400,
                message: limitMessage,
            });
        },
    );

    it.each([false, true])('counts ignored files in the exact 5 MiB source budget (gzip=%s)', async (compressed) => {
        const content = Buffer.alloc(MiB, 'x');
        const entries = [
            { path: source.path, content },
            ...Array.from({ length: 4 }, (_, index) => ({
                path: `project/node_modules/ignored-${index}.js`,
                content,
            })),
        ];
        await expect(read(tar(entries), compressed)).resolves.toEqual({
            files: [{ path: 'index.ts', content: content.toString() }],
            skipped: 4,
            rootName: 'project',
        });
        await expect(
            read(tar([...entries, { path: 'project/.env', content: Buffer.from('x') }]), compressed),
        ).rejects.toMatchObject({ status: 400, message: limitMessage });
    });

    it('accepts an 8 MiB TAR container and rejects one extra input byte', async () => {
        await expect(read(padded(tar([source]), 8 * MiB))).resolves.toMatchObject({
            files: [{ path: 'index.ts', content: source.content.toString() }],
            skipped: 0,
        });
        await expect(read(padded(tar([source]), 8 * MiB + 1))).rejects.toMatchObject({
            status: 400,
            message: 'Архив должен быть корректным base64 размером до 8 МиБ.',
        });
    });

    it('applies the 8 MiB input limit to a gzip upload before decompression', async () => {
        const bytes = padded(gzipSync(tar([source])), 8 * MiB + 1);
        await expect(
            readSourceArchive({ name: 'source.tgz', contentBase64: bytes.toString('base64') }),
        ).rejects.toMatchObject({
            status: 400,
            message: 'Архив должен быть корректным base64 размером до 8 МиБ.',
        });
    });

    it('accepts 10 MiB expanded TAR and rejects another block despite a small gzip input', async () => {
        await expect(read(padded(tar([source]), 10 * MiB), true)).resolves.toMatchObject({
            files: [{ path: 'index.ts', content: source.content.toString() }],
            skipped: 0,
        });
        await expect(read(padded(tar([source]), 10 * MiB + 512), true)).rejects.toMatchObject({
            status: 400,
            message: 'Распакованный архив превышает допустимый размер.',
        });
    });

    it.each(['../outside.ts', 'project/../../outside.ts', '/absolute.ts'])(
        'rejects traversal or absolute path %s',
        async (path) => {
            await expect(read(tar([{ ...source, path }]))).rejects.toMatchObject({ status: 400 });
        },
    );

    it('rejects a symlink instead of following its target', async () => {
        await expect(read(tar([source, { path: 'project/link.ts', linkpath: 'index.ts' }]))).rejects.toMatchObject({
            status: 400,
            message: 'Ссылки и специальные записи TAR запрещены.',
        });
    });

    it.each(['project/index.ts', 'project/INDEX.ts'])('rejects duplicate path %s', async (path) => {
        await expect(read(tar([source, { ...source, path }]))).rejects.toMatchObject({
            status: 400,
            message: 'В архиве повторяются или конфликтуют пути файлов.',
        });
    });
});
