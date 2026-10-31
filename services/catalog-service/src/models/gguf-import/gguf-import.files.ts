import { ConflictException } from '@nestjs/common';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UploadFiles } from '../../source-upload/source-upload.files';

/** Streamed GGUF storage uses the same UUID-only, nofollow boundary as tool-source storage. */
export class GgufImportFiles extends UploadFiles {
    async digest(
        id: string,
        bytes: number,
        expected?: string | null,
        check: () => Promise<void> = async () => {},
        checkIntervalMs = 1000,
    ): Promise<string> {
        const file = await fs.open(this.filename(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const before = await file.stat();
            if (!before.isFile() || before.nlink !== 1 || before.size !== bytes || (before.mode & 0o222) !== 0)
                throw new ConflictException('Сохранённый GGUF изменён или недоступен.');
            const hash = createHash('sha256');
            let received = 0,
                lastCheck = 0;
            for await (const chunk of file.createReadStream({ autoClose: false })) {
                received += chunk.length;
                if (received > bytes) throw new ConflictException('Размер GGUF изменился.');
                hash.update(chunk);
                if (Date.now() - lastCheck >= checkIntervalMs) {
                    lastCheck = Date.now();
                    await check();
                }
            }
            const after = await file.stat(),
                sha256 = hash.digest('hex');
            if (
                received !== bytes ||
                (expected && sha256 !== expected) ||
                before.ino !== after.ino ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                after.nlink !== 1
            )
                throw new ConflictException('SHA-256 GGUF изменился.');
            return sha256;
        } finally {
            await file.close();
        }
    }
    async receiveGguf(
        input: Readable,
        id: string,
        token: string,
        bytes: number,
        expected: string | null,
        signal: AbortSignal,
        check: () => Promise<void>,
        checkIntervalMs: number,
    ): Promise<string> {
        const filename = this.partial(id, token),
            hash = createHash('sha256');
        let received = 0,
            lastCheck = 0;
        try {
            await pipeline(
                input,
                new Transform({
                    transform(chunk: Buffer, _encoding, done) {
                        received += chunk.length;
                        if (received > bytes) {
                            done(new ConflictException('GGUF превышает заявленный размер.'));
                            return;
                        }
                        hash.update(chunk);
                        if (Date.now() - lastCheck >= checkIntervalMs) {
                            lastCheck = Date.now();
                            void check().then(() => done(null, chunk), done);
                        } else done(null, chunk);
                    },
                }),
                createWriteStream(filename, { flags: 'wx', mode: 0o600 }),
                { signal },
            );
            const digest = hash.digest('hex');
            if (received !== bytes || (expected && digest !== expected))
                throw new ConflictException('Поток GGUF оборвался или SHA-256 не совпала. Повторите тот же файл.');
            const handle = await fs.open(filename, constants.O_RDWR | constants.O_NOFOLLOW);
            try {
                await handle.chmod(0o400);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await check();
            await fs.rename(filename, this.filename(id));
            const directory = await fs.open(this.root, 'r');
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
            return digest;
        } finally {
            await fs.rm(filename, { force: true });
        }
    }
}
