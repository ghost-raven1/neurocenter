import { ServiceUnavailableException } from '@nestjs/common';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { IBridgeArtifact, IBridgeSupply } from './bridge-supply.types';

const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
interface IDevPointer {
    version: string;
    buildId: string;
    target: string;
    directory: string;
    sourceCommit: string;
}
export interface IDevBridgeRuntime {
    supply: IBridgeSupply;
    artifact: IBridgeArtifact;
    archive: FileHandle;
}
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

function hostTarget(): string {
    const platforms: Partial<Record<NodeJS.Platform, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
    const platform = platforms[process.platform];
    if (!platform || !['x64', 'arm64'].includes(process.arch)) {
        throw new Error('Unsupported development bridge host.');
    }
    const report =
        process.platform === 'linux'
            ? (process.report.getReport() as { header: { glibcVersionRuntime?: string } })
            : undefined;
    return `${platform}-${process.arch}${report && !report.header.glibcVersionRuntime ? '-musl' : ''}`;
}

async function canonical(directory: string): Promise<string> {
    const resolved = await realpath(directory);
    if (resolved !== directory) {
        throw new Error('Development bridge supply must not follow symbolic links.');
    }
    return resolved;
}

async function ordinary(filename: string, maximum: number): Promise<FileHandle> {
    await canonical(filename);
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > maximum) {
            throw new Error('Invalid development bridge file.');
        }
        return file;
    } catch (error) {
        await file.close();
        throw error;
    }
}

async function text(filename: string, maximum: number, replaceablePointer = false): Promise<string> {
    const file = await ordinary(filename, maximum);
    try {
        const before = await file.stat();
        if (before.size > maximum) {
            throw new Error('Development bridge metadata exceeds its limit.');
        }
        const bytes = Buffer.allocUnsafe(maximum + 1);
        let received = 0;
        while (received < bytes.length) {
            const read = await file.read(bytes, received, bytes.length - received, received);
            if (!read.bytesRead) {
                break;
            }
            received += read.bytesRead;
        }
        const after = await file.stat();
        if (
            received > maximum ||
            received !== before.size ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs
        ) {
            throw new Error('Development bridge metadata changed while reading.');
        }
        if (before.ctimeMs !== after.ctimeMs) {
            // Atomic pointer replacement unlinks the old FD; in-place writes must still fail.
            const current = replaceablePointer && after.nlink === 0 ? await lstat(filename) : undefined;
            if (
                !current?.isFile() ||
                current.isSymbolicLink() ||
                current.nlink !== 1 ||
                (current.dev === before.dev && current.ino === before.ino)
            ) {
                throw new Error('Development bridge metadata identity changed while reading.');
            }
        }
        return bytes.subarray(0, received).toString('utf8');
    } finally {
        await file.close();
    }
}

function pointer(value: unknown): IDevPointer {
    if (
        !object(value) ||
        Object.keys(value).some(
            (key) => !['version', 'buildId', 'target', 'directory', 'sourceCommit'].includes(key),
        ) ||
        typeof value.version !== 'string' ||
        !VERSION.test(value.version) ||
        typeof value.buildId !== 'string' ||
        !SHA.test(value.buildId) ||
        value.target !== hostTarget() ||
        typeof value.directory !== 'string' ||
        !/^generation-[a-zA-Z0-9_-]{1,128}$/.test(value.directory) ||
        typeof value.sourceCommit !== 'string' ||
        !/^[a-f0-9]{40}$/.test(value.sourceCommit)
    ) {
        throw new Error('Invalid development bridge pointer.');
    }
    return value as unknown as IDevPointer;
}

function artifact(value: unknown, current: IDevPointer, file: string): IBridgeArtifact {
    if (
        !object(value) ||
        Object.keys(value).some(
            (key) =>
                ![
                    'version',
                    'target',
                    'nodeVersion',
                    'buildId',
                    'ragSupported',
                    'probeEngine',
                    'windowsJobHelper',
                    'sha256',
                    'bytes',
                ].includes(key),
        ) ||
        value.version !== current.version ||
        value.buildId !== current.buildId ||
        value.target !== current.target ||
        typeof value.nodeVersion !== 'string' ||
        !/^24\.\d+\.\d+$/.test(value.nodeVersion) ||
        typeof value.ragSupported !== 'boolean' ||
        typeof value.sha256 !== 'string' ||
        !SHA.test(value.sha256) ||
        !Number.isSafeInteger(value.bytes) ||
        Number(value.bytes) <= 0 ||
        Number(value.bytes) > 1024 ** 3 ||
        !object(value.probeEngine) ||
        typeof value.probeEngine.version !== 'string' ||
        !VERSION.test(value.probeEngine.version) ||
        value.probeEngine.file !== `bin/opencode-probe${current.target.startsWith('windows-') ? '.exe' : ''}` ||
        typeof value.probeEngine.sha256 !== 'string' ||
        !SHA.test(value.probeEngine.sha256) ||
        (value.windowsJobHelper !== undefined &&
            (!object(value.windowsJobHelper) ||
                value.windowsJobHelper.file !== 'bin/neurocenter-job.exe' ||
                typeof value.windowsJobHelper.sha256 !== 'string' ||
                !SHA.test(value.windowsJobHelper.sha256)))
    ) {
        throw new Error('Invalid development bridge metadata.');
    }
    return {
        file,
        target: current.target,
        sha256: value.sha256,
        bytes: Number(value.bytes),
        metadata: value as IBridgeArtifact['metadata'],
    };
}

/** A dev pointer selects one immutable host generation; published catalog pins are never changed. */
export async function readDevBridgeRuntime(
    directory: string,
    signal: AbortSignal,
): Promise<IDevBridgeRuntime | undefined> {
    let archive: FileHandle | undefined;
    try {
        if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
            throw new Error('Development bridge directory must be absolute.');
        }
        let root;
        try {
            root = await lstat(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
        if (!root.isDirectory() || root.isSymbolicLink()) {
            throw new Error('Invalid development bridge directory.');
        }
        await canonical(directory);
        const pointerFile = path.join(directory, 'current.json');
        let currentInfo;
        try {
            currentInfo = await lstat(pointerFile);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
        if (!currentInfo.isFile() || currentInfo.isSymbolicLink()) {
            throw new Error('Invalid development bridge pointer file.');
        }
        const raw = await text(pointerFile, 8192, true);
        signal.throwIfAborted();
        const current = pointer(JSON.parse(raw)),
            generation = await canonical(path.join(directory, current.directory));
        const name = `neurocenter-asset-sync-${current.target}-${current.version}.tgz`;
        const selected = artifact(JSON.parse(await text(path.join(generation, name + '.json'), 65536)), current, name);
        if ((await text(path.join(generation, name + '.sha256'), 128)).trim() !== selected.sha256) {
            throw new Error('Development bridge checksum sidecar differs.');
        }
        archive = await ordinary(path.join(generation, name), 1024 ** 3);
        const before = await archive.stat(),
            hash = createHash('sha256');
        let received = 0;
        signal.throwIfAborted();
        // Pipeline attaches error listeners before it owns cancellation of the stream.
        await pipeline(
            archive.createReadStream({ start: 0, autoClose: false }),
            async (parts) => {
                for await (const part of parts) {
                    received += part.length;
                    if (received > selected.bytes) {
                        throw new Error('Development bridge archive exceeds metadata.');
                    }
                    hash.update(part);
                }
            },
            { signal },
        );
        const after = await archive.stat();
        if (
            before.size !== selected.bytes ||
            received !== selected.bytes ||
            hash.digest('hex') !== selected.sha256 ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
        ) {
            throw new Error('Development bridge archive changed or failed its checksum.');
        }
        signal.throwIfAborted();
        return {
            supply: {
                assetId: 'neurocenter-bridge-dev',
                version: current.version,
                buildId: current.buildId,
                sourceCommit: current.sourceCommit,
                artifacts: [selected],
            },
            artifact: selected,
            archive,
        };
    } catch {
        await archive?.close();
        throw new ServiceUnavailableException(
            'Локальная dev-поставка моста не прошла проверку. Повторите dev.sh install.',
        );
    }
}
