import { ConflictException } from '@nestjs/common';
import { toToolPublication, type ToolAsset } from '@neurocenter/asset-contract';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';
import type { AssetSourcesService } from '../asset-sources/asset-sources.service';
import type { IAiPluginCreate } from '../catalog/dto';
import { PluginRepository } from '../publication/plugin-repository';
import { RuntimeArtifacts, runtimeArtifactDirectory } from '../runtime-artifacts/runtime-artifacts';
import { configureBuildPublicationTransaction } from './publication-deadline';
import { withVerifiedToolImport } from './verify-imported-tool';

/** Preserve the existing source/version publication key and direct response under one import owner. */
export async function importToolAsset(
    pool: Pool,
    artifacts: RuntimeArtifacts,
    sources: AssetSourcesService,
    asset: ToolAsset,
    requestKey: string,
    actor: string,
    guard: () => Promise<void>,
    signal: AbortSignal,
) {
    const files = asset.delivery.artifacts.map(({ descriptor }) => ({
        archivePath: path.join(runtimeArtifactDirectory(), descriptor.sha256 + '.tar.gz'),
        sha256: descriptor.sha256,
        bytes: descriptor.compressedBytes,
        filename: descriptor.sha256 + '.tar.gz',
        target: descriptor.target,
    }));
    for (const [index, file] of files.entries()) {
        signal.throwIfAborted();
        try {
            await artifacts.importArchive(file.archivePath, asset.delivery.artifacts[index].descriptor, signal);
        } catch {
            signal.throwIfAborted();
            throw new ConflictException(
                'Проверенный архив поставки отсутствует или повреждён. Загрузите исходную поставку повторно.',
            );
        }
    }
    signal.throwIfAborted();
    const prepared = await sources.prepareLocal(asset, files, requestKey, undefined, undefined, signal),
        bytes = createHash('sha256')
            .update('neurocenter-source-asset\0' + asset.id + '\0' + asset.version)
            .digest()
            .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex'),
        publicationKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return withVerifiedToolImport(
        prepared,
        sources.blobs,
        async (runtimeVerification) => {
            await guard();
            signal.throwIfAborted();
            let result: unknown;
            const plugins = new PluginRepository(pool, undefined, async (client) => {
                signal.throwIfAborted();
                await configureBuildPublicationTransaction(client);
                signal.throwIfAborted();
            });
            const saved = await plugins.create(
                { ...toToolPublication(asset), publicationKey } as IAiPluginCreate,
                actor,
                async (client, card) => {
                    await guard();
                    signal.throwIfAborted();
                    const source = await sources.recordLocal(client, prepared, card, actor, undefined, signal);
                    await guard();
                    signal.throwIfAborted();
                    result = {
                        catalogId: card.id,
                        name: card.name,
                        version: card.version,
                        ...source,
                        runtimeVerification,
                    };
                },
            );
            return result || { catalogId: saved.id, name: saved.name, version: saved.version, runtimeVerification };
        },
        signal,
    );
}
