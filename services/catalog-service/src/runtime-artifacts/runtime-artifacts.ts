import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inspectRuntimeArchive, normalizeRuntimeArtifacts, type RuntimeArtifact } from '../../../shared/runtime-artifacts.cjs';
import { DeviceStore } from '../devices/device-store';
import { reserveCapacity } from '../../../shared/capacity.cjs';
import {withImportRegistryTransaction} from '../database/import-registry-transaction';

export const runtimeArtifactDirectory = (): string => path.resolve(process.env.RUNTIME_ARTIFACT_DIR || '/app/runtime-artifacts');

/** Неизменяемое хранилище готовых архивов: импорт не запускает чужие скрипты. */
@Injectable()
export class RuntimeArtifacts {
    constructor(private readonly devices: DeviceStore) {}

    async importArchive(source: string, input: unknown,signal?:AbortSignal): Promise<RuntimeArtifact> {
        signal?.throwIfAborted();
        const [descriptor] = normalizeRuntimeArtifacts([input]);
        await inspectRuntimeArchive(source, descriptor,{signal});
        signal?.throwIfAborted();
        const root = runtimeArtifactDirectory();
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const info = await fs.lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) { throw new BadRequestException('Хранилище артефактов заменено ссылкой.'); }
        // Предзагрузка уже разместила проверенный SHA-файл: повторная копия не нужна.
        if (path.resolve(source) === path.join(root, descriptor.sha256 + '.tar.gz')) {
            const releaseRegistry = await reserveCapacity({resource:'postgres',bytes:65536});
            try { return await this.registerArchive(descriptor,signal); } finally { releaseRegistry(); }
        }
        const releaseCapacity=await reserveCapacity({resource:'runtime-artifacts',bytes:descriptor.compressedBytes,path:root});
        let releaseRegistry=()=>{};
        try {
            releaseRegistry=await reserveCapacity({resource:'postgres',bytes:65536});
            signal?.throwIfAborted();return await this.importCheckedArchive(source,descriptor,root,signal);
        } finally { releaseRegistry();releaseCapacity(); }
    }

    private async importCheckedArchive(source:string,descriptor:RuntimeArtifact,root:string,signal?:AbortSignal):Promise<RuntimeArtifact> {
        const target = path.join(root, descriptor.sha256 + '.tar.gz');
        const temporary = path.join(root, '.' + randomUUID() + '.partial');
        const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const output = await fs.open(temporary, 'wx', 0o600);
            try {
                let bytes = 0;
                const digest = createHash('sha256');
                await pipeline(handle.createReadStream({ autoClose: false, start: 0 }), new Transform({ transform(chunk: Buffer, _encoding, callback) {
                    bytes += chunk.length;
                    if (bytes > descriptor.compressedBytes) { callback(new Error('Архив изменился во время импорта.')); return; }
                    digest.update(chunk); callback(null, chunk);
                } }), new Writable({ write(chunk: Buffer, _encoding, callback) { output.writeFile(chunk).then(() => callback(), callback); } }),{signal});
                if (bytes !== descriptor.compressedBytes || digest.digest('hex') !== descriptor.sha256) { throw new BadRequestException('Архив изменился во время импорта.'); }
                await output.sync();
            } finally { await output.close(); }
            signal?.throwIfAborted();
            await fs.chmod(temporary, 0o400);
            try { await fs.link(temporary, target); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
            await fs.unlink(temporary);
            if (process.platform !== 'win32') { const directoryHandle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } }
            await inspectRuntimeArchive(target, descriptor,{signal});
            return await this.registerArchive(descriptor,signal);
        } finally { await handle.close(); await fs.rm(temporary, { force: true }); }
    }

    /** Квитанция принимает только точную опись ранее проверенного неизменяемого файла. */
    private async registerArchive(descriptor:RuntimeArtifact,signal?:AbortSignal):Promise<RuntimeArtifact> {
        return withImportRegistryTransaction(this.devices.pool,signal,async client=>{
        signal?.throwIfAborted();
        await client.query(`INSERT INTO bridge_runtime_artifacts(sha256,compressed_bytes,unpacked_bytes,files_count)
            VALUES($1,$2,$3,$4) ON CONFLICT(sha256) DO NOTHING`,
        [descriptor.sha256, descriptor.compressedBytes, descriptor.unpackedBytes, descriptor.filesCount]);
        signal?.throwIfAborted();
        const { rows } = await client.query('SELECT compressed_bytes,unpacked_bytes,files_count FROM bridge_runtime_artifacts WHERE sha256=$1', [descriptor.sha256]);
        if (!rows[0] || Number(rows[0].compressed_bytes) !== descriptor.compressedBytes || Number(rows[0].unpacked_bytes) !== descriptor.unpackedBytes || Number(rows[0].files_count) !== descriptor.filesCount) {
            throw new ConflictException('Существующий артефакт имеет другую опись.');
        }
        signal?.throwIfAborted();
        return descriptor;
        });
    }

    /** Авторизацию устройства, lease и одобренного графа вызывающий маршрут проверяет до открытия. */
    async open(sha256: string): Promise<{ stream: ReturnType<fs.FileHandle['createReadStream']>; bytes: number; sha256: string }> {
        if (!/^[a-f0-9]{64}$/.test(sha256)) { throw new BadRequestException('Некорректный SHA-256 артефакта.'); }
        const { rows } = await this.devices.pool.query('SELECT compressed_bytes FROM bridge_runtime_artifacts WHERE sha256=$1', [sha256]);
        if (!rows[0]) { throw new NotFoundException('Готовый комплект ещё не загружен оператором.'); }
        const handle = await fs.open(path.join(runtimeArtifactDirectory(), sha256 + '.tar.gz'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new NotFoundException('Файл готового комплекта недоступен.'); });
        try {
            const before = await handle.stat();
            if (!before.isFile() || before.nlink !== 1 || before.size !== Number(rows[0].compressed_bytes)) { throw new ConflictException('Артефакт повреждён. Повторите операторский импорт.'); }
            const digest = createHash('sha256'); let readBytes = 0;
            for await (const chunk of handle.createReadStream({ autoClose: false })) { readBytes += chunk.length; if (readBytes > before.size) { throw new ConflictException('Артефакт изменился во время чтения.'); } digest.update(chunk); }
            const after = await handle.stat();
            if (digest.digest('hex') !== sha256 || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) { throw new ConflictException('Артефакт изменился в хранилище.'); }
            return { stream: handle.createReadStream({ autoClose: true, start: 0 }), bytes: before.size, sha256 };
        } catch (error) { await handle.close(); throw error; }
    }
}
