import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileFingerprint } from '../../bridge/read-bounded.js';
import { snapshotCanonicalJson } from './contract.js';

const unsupported = () =>
    new Error(
        'Полный снимок поддерживает плоскую локальную LanceDB. Каталог пространств имён или внешних таблиц не включён; перенесите данные в обычные локальные таблицы перед публикацией.',
    );
/** Inspect namespace metadata in an owned copy: SDK inspection must never migrate the source catalog. */
export async function assertFlatNamespace(
    store: string,
    connect: (directory: string) => Promise<import('@lancedb/lancedb').Connection>,
    checkpoint: () => Promise<void>,
) {
    const directory = path.join(store, '__manifest');
    const inspect = async (destination?: string) => {
        const proof: Record<string, string> = Object.create(null) as Record<string, string>;
        let total = 0,
            entries = 0;
        try {
            await fs.lstat(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        const walk = async (relative: string, depth: number): Promise<void> => {
            if (depth > 32 || ++entries > 2048) throw unsupported();
            await checkpoint();
            const file = path.join(directory, ...relative.split('/').filter(Boolean)),
                stat = await fs.lstat(file, { bigint: true });
            if (stat.isSymbolicLink()) throw unsupported();
            if (stat.isDirectory()) {
                proof[relative] = 'd:' + fileFingerprint(stat) + ':' + stat.birthtimeNs;
                if (destination) await fs.mkdir(path.join(destination, relative), { recursive: true, mode: 0o700 });
                for await (const entry of await fs.opendir(file)) {
                    if (!/^[a-zA-Z0-9_.-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..')
                        throw unsupported();
                    await walk(relative ? relative + '/' + entry.name : entry.name, depth + 1);
                }
                if (fileFingerprint(await fs.lstat(file, { bigint: true })) !== fileFingerprint(stat))
                    throw unsupported();
            } else {
                if (
                    !stat.isFile() ||
                    stat.nlink !== 1n ||
                    stat.size < 0n ||
                    stat.size > 64n * 1024n * 1024n ||
                    total + Number(stat.size) > 64 * 1024 * 1024
                )
                    throw unsupported();
                total += Number(stat.size);
                const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                    if (fileFingerprint(await handle.stat({ bigint: true })) !== fileFingerprint(stat))
                        throw unsupported();
                    const bytes = Buffer.allocUnsafe(Number(stat.size));
                    let read = 0;
                    while (read < bytes.length) {
                        const part = await handle.read(bytes, read, bytes.length - read, read);
                        if (!part.bytesRead) throw unsupported();
                        read += part.bytesRead;
                    }
                    if ((await handle.read(Buffer.alloc(1), 0, 1, read)).bytesRead) throw unsupported();
                    if (
                        bytes.length !== Number(stat.size) ||
                        fileFingerprint(await handle.stat({ bigint: true })) !== fileFingerprint(stat) ||
                        fileFingerprint(await fs.lstat(file, { bigint: true })) !== fileFingerprint(stat)
                    )
                        throw unsupported();
                    proof[relative] =
                        'f:' + fileFingerprint(stat) + ':' + createHash('sha256').update(bytes).digest('hex');
                    if (destination)
                        await fs.writeFile(path.join(destination, relative), bytes, { flag: 'wx', mode: 0o600 });
                } finally {
                    await handle.close();
                }
            }
        };
        await walk('', 0);
        return snapshotCanonicalJson(proof);
    };
    const before = await inspect();
    if (before !== null) {
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-snapshot-catalog-'));
        try {
            const catalog = path.join(temporary, 'catalog.lance');
            if ((await inspect(catalog)) !== before) throw unsupported();
            const database = await connect(temporary);
            try {
                const table = await database.openTable('catalog');
                try {
                    if ((await table.countRows()) !== 0) throw unsupported();
                } finally {
                    table.close();
                }
            } finally {
                database.close();
            }
        } finally {
            await fs.rm(temporary, { recursive: true, force: true });
        }
    }
    const assertCurrent = async () => {
        if ((await inspect()) !== before) throw unsupported();
    };
    await assertCurrent();
    return assertCurrent;
}
