import { ConflictException } from '@nestjs/common';
import {
    assetDigest,
    downloadArtifacts,
    selectAssets,
    type AssetIndex,
    type ResolvedAsset,
} from '@neurocenter/asset-contract';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { AssetSourceClient, type IAssetSourcePin } from './source-client';

export interface IArchiveFile {
    path: string;
    bytes: number;
    sha256: string;
}
export interface IValidatedSourceArchive {
    pin: IAssetSourcePin;
    index: AssetIndex;
    records: ResolvedAsset[];
    metadata: Map<string, IArchiveFile>;
    blobs: Map<string, IArchiveFile>;
}

/** Bounded immutable staged bytes, checked again before metadata parsing. */
export async function readArchiveMetadata(file: IArchiveFile, maximum: number): Promise<Uint8Array> {
    if (file.bytes > maximum) throw new ConflictException('Metadata архива превышает допустимый размер.');
    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes)
            throw new ConflictException('Metadata архива изменена.');
        const chunks: Buffer[] = [];
        let count = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            count += chunk.length;
            if (count > maximum || count > file.bytes) throw new ConflictException('Metadata архива изменена.');
            chunks.push(chunk);
        }
        const after = await handle.stat(),
            bytes = Buffer.concat(chunks);
        if (
            count !== file.bytes ||
            before.ino !== after.ino ||
            before.dev !== after.dev ||
            before.mtimeMs !== after.mtimeMs ||
            before.size !== after.size ||
            assetDigest(bytes) !== file.sha256
        )
            throw new ConflictException('SHA-256 metadata архива не подтверждён.');
        return bytes;
    } catch (error) {
        if (error instanceof ConflictException) throw error;
        throw new ConflictException('Metadata архива недоступна или повреждена. Повторите загрузку.');
    } finally {
        await handle?.close();
    }
}

/** No archive filename or GitHub folder name may invent a trusted Git commit. */
export async function validateSourceArchive(
    files: Map<string, IArchiveFile>,
    pins: IAssetSourcePin[],
    signal: AbortSignal,
): Promise<IValidatedSourceArchive> {
    const bySha = new Map<string, IArchiveFile>(),
        presentBlobs = new Map<string, IArchiveFile>();
    for (const [name, file] of files) {
        signal.throwIfAborted();
        if (name.startsWith('.asset-source-metadata/') || name.startsWith('.asset-source-blobs/')) {
            const blob = name.startsWith('.asset-source-blobs/'),
                match = name.match(
                    blob
                        ? /^\.asset-source-blobs\/([a-f0-9]{64})\.blob$/
                        : /^\.asset-source-metadata\/([a-f0-9]{64})\.json$/,
                );
            if (!match || match[1] !== file.sha256 || (!blob && file.bytes > 16 * 1024 ** 2))
                throw new ConflictException('SHA-файл локальной поставки повреждён или имеет неверное имя.');
            if (blob) presentBlobs.set(file.sha256, file);
        }
        const previous = bySha.get(file.sha256);
        if (previous && previous.bytes !== file.bytes)
            throw new ConflictException('Один SHA архива имеет разные размеры.');
        bySha.set(file.sha256, file);
    }
    const raw = files.get('index.json');
    const pin = raw
        ? pins.find((candidate) => candidate.index.path === 'index.json' && candidate.index.sha256 === raw.sha256)
        : pins.find((candidate) => files.has('.asset-source-metadata/' + candidate.index.sha256 + '.json'));
    if (!pin)
        throw new ConflictException(
            'Опись архива не совпадает с закреплённым или ранее проверенным источником. Нужен архив соответствующего релиза приложения либо ранее проверенной версии ассетов.',
        );
    const metadata = new Map<string, IArchiveFile>();
    let total = 0;
    const cache = {
        read: async (sha: string, maximum: number) => {
            signal.throwIfAborted();
            const file = bySha.get(sha);
            if (!file) return undefined;
            if (!metadata.has(sha)) {
                total += file.bytes;
                if (total > 32 * 1024 ** 2) throw new ConflictException('Metadata архива превышает 32 МиБ.');
                metadata.set(sha, file);
            }
            return readArchiveMetadata(file, maximum);
        },
    };
    const source = new AssetSourceClient(
        pin,
        async () => {
            throw new Error('Archive metadata must never use the network');
        },
        signal,
        { offline: true, cache },
    );
    const index = await source.index();
    if (index.assets.length > 300) throw new ConflictException('В архиве более 300 описей ассетов.');
    const records: ResolvedAsset[] = [];
    for (const entry of index.assets) {
        signal.throwIfAborted();
        records.push(await source.descriptor(entry));
    }
    try {
        selectAssets(
            records,
            index.assets.filter((entry) => entry.current).map((entry) => entry.id),
        );
        // Historical orphan versions must retain a valid exact graph too.
        const versions = new Map(records.map((record) => [record.asset.id + '@' + record.asset.version, record])),
            done = new Set<string>(),
            visiting = new Set<string>();
        const visit = (record: ResolvedAsset) => {
            const key = record.asset.id + '@' + record.asset.version;
            if (done.has(key)) return;
            if (visiting.has(key)) throw new Error();
            visiting.add(key);
            for (const dependency of record.asset.dependencies ?? []) {
                const target = versions.get(dependency.id + '@' + dependency.version);
                if (!target || target.sha256 !== dependency.sha256) throw new Error();
                visit(target);
            }
            visiting.delete(key);
            done.add(key);
        };
        records.forEach(visit);
    } catch {
        throw new ConflictException('Архив содержит несовместимые точные зависимости или цикл версий.');
    }
    if (new Set(records.filter((record) => record.asset.kind === 'bridge').map((record) => record.asset.id)).size > 1)
        throw new ConflictException('Архив содержит несколько несовместимых мостов.');
    const expected = new Map<string, number>(),
        blobs = new Map<string, IArchiveFile>();
    for (const record of records)
        for (const artifact of downloadArtifacts(record.asset)) {
            const previous = expected.get(artifact.sha256);
            if (previous !== undefined && previous !== artifact.bytes)
                throw new ConflictException('Один SHA поставки имеет разные размеры в описях.');
            expected.set(artifact.sha256, artifact.bytes);
            const file = presentBlobs.get(artifact.sha256);
            if (file) {
                if (file.bytes !== artifact.bytes)
                    throw new ConflictException('Размер файла поставки не совпадает с описью.');
                blobs.set(artifact.sha256, file);
            }
        }
    return { pin, index, records, metadata, blobs };
}
