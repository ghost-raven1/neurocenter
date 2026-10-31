import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats, Stats } from 'node:fs';
import { safeTarget } from './workspace.js';

export class InspectionReadError extends Error {
    constructor(readonly issue: 'unsafe-path' | 'source-changed' | 'read-failed' | 'read-limit') {
        super(issue);
    }
}
const fingerprint = (stat: Stats | BigIntStats): string =>
    [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

/** Ограниченное чтение не следует за leaf-симлинком и не открывает FIFO в блокирующем режиме. */
export class InspectionReader {
    private readonly snapshots = new Map<string, string | null>();
    private remaining = 64 * 1048576;
    constructor(private readonly root: string) {}
    async read(relative: string, maximum: number): Promise<Buffer | null> {
        let target: string;
        try {
            target = await safeTarget(this.root, relative);
        } catch {
            throw new InspectionReadError('unsafe-path');
        }
        try {
            const before = await fs.lstat(target);
            if (!before.isFile() || before.isSymbolicLink()) {
                throw new InspectionReadError('unsafe-path');
            }
            this.snapshots.set(relative, fingerprint(before));
            if (before.size > maximum || before.size > this.remaining) {
                throw new InspectionReadError('read-limit');
            }
            const handle = await fs.open(
                target,
                constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
            );
            try {
                const opened = await handle.stat();
                if (!opened.isFile()) {
                    throw new InspectionReadError('unsafe-path');
                }
                if (fingerprint(opened) !== fingerprint(before)) {
                    throw new InspectionReadError('source-changed');
                }
                const buffer = Buffer.alloc(Math.min(maximum + 1, opened.size + 1));
                let length = 0;
                while (length < buffer.length) {
                    const read = await handle.read(buffer, length, buffer.length - length, null);
                    if (!read.bytesRead) {
                        break;
                    }
                    length += read.bytesRead;
                }
                if (fingerprint(await handle.stat()) !== fingerprint(before)) {
                    throw new InspectionReadError('source-changed');
                }
                if (length > maximum || length > this.remaining) {
                    throw new InspectionReadError('read-limit');
                }
                this.remaining -= length;
                return buffer.subarray(0, length);
            } finally {
                await handle.close();
            }
        } catch (error) {
            if (error instanceof InspectionReadError) {
                throw error;
            }
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                if (this.snapshots.get(relative)) {
                    throw new InspectionReadError('source-changed');
                }
                this.snapshots.set(relative, null);
                return null;
            }
            if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                throw new InspectionReadError('unsafe-path');
            }
            throw new InspectionReadError('read-failed');
        }
    }
    async verify(): Promise<void> {
        for (const [relative, before] of this.snapshots) {
            try {
                const stat = await fs.lstat(await safeTarget(this.root, relative));
                if (!stat.isFile() || fingerprint(stat) !== before) {
                    throw new InspectionReadError('source-changed');
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT' && before === null) {
                    continue;
                }
                throw new InspectionReadError('source-changed');
            }
        }
    }
}
