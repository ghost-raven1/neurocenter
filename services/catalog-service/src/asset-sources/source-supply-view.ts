import { downloadArtifacts, selectAssets, type ResolvedAsset } from '@neurocenter/asset-contract';
import type { AssetBlobStore } from './asset-blob-store';

/** Availability counts unique pinned bytes across the exact dependency closure, without fetching. */
export async function sourceSupplyViews(
    records: ResolvedAsset[],
    blobs: AssetBlobStore,
): Promise<Map<string, { ready: boolean; missingFiles: number; missingBytes: number }>> {
    const available = new Map<string, Promise<boolean>>(),
        result = new Map<string, { ready: boolean; missingFiles: number; missingBytes: number }>();
    for (const record of records.filter((record) => record.current)) {
        const files = new Map<string, ReturnType<typeof downloadArtifacts>[number]>();
        for (const dependency of selectAssets(records, [record.asset.id]))
            for (const file of downloadArtifacts(dependency.asset)) files.set(file.sha256, file);
        let missingFiles = 0,
            missingBytes = 0;
        for (const file of files.values()) {
            const key = file.sha256 + ':' + file.bytes;
            if (!available.has(key)) available.set(key, blobs.hasLocalCandidate(file.sha256, file.bytes));
            if (!(await available.get(key))) {
                missingFiles++;
                missingBytes += file.bytes;
            }
        }
        result.set(record.asset.id, { ready: missingFiles === 0, missingFiles, missingBytes });
    }
    return result;
}
