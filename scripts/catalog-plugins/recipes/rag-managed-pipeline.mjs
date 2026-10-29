import fs from 'node:fs/promises';
import path from 'node:path';

const replacements = [
    ['export async function runIndexPass(options) {', 'export async function runIndexPass(options) {\n    assertManagedQuirksSource(options.storePath);'],
    ['return await runIndexPassInner(options, logger);', 'return await withManagedIndexProfile(options, next => runIndexPassInner(next, logger));'],
    ['if (!tempStoreWroteChunks) {', 'if (!tempStoreWroteChunks || stats.embeddingUnavailable || stats.embeddingFailures > 0 || stats.extractionFailures > 0 || stats.descriptionFailedFiles > 0) {', 2],
    ['await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");', 'if (!await acquireManagedIndexLock(lockPath)) return { ...createIndexStats(0, "missing"), skipped: true };'],
    ['logger.debug(`Could not write index lock file: ${err.message} — concurrent-pass protection disabled`);', 'return { ...createIndexStats(0, "missing"), skipped: true }; // Не перезаписываем чужой lock и не работаем без него.'],
    ['await fs.unlink(lockPath);', 'await releaseManagedIndexLock(lockPath);', 3],
    ['await swapStoreDirectories(tempStorePath, options.storePath);', 'await fs.copyFile(path.join(options.storePath, LOCK_FILE), path.join(tempStorePath, LOCK_FILE), 1); // COPYFILE_EXCL: lock сохраняется при promotion.\n                    await preserveManagedSessionLock(options.storePath, tempStorePath);\n                    await swapStoreDirectories(tempStorePath, options.storePath);'],
];

/** Один guarded pipeline используется плагином, MCP и настоящим Web UI. */
export function managedPipelineSource(source) {
    if (replacements.some(([before, , count = 1]) => source.split(before).length !== count + 1) || source.includes('withManagedIndexProfile')) {
        throw new Error('Изменилась точка инициализации OpenCodeRAG; требуется обновить адаптер индекса.');
    }
    return 'import { assertManagedQuirksSource } from \"../../../rag-quirks-guard.mjs\";\n'
        + 'import { withManagedIndexProfile } from "../../../rag-index-profile.mjs";\n'
        + 'import { acquireManagedIndexLock, releaseManagedIndexLock, preserveManagedSessionLock } from "../../../rag-index-lock.mjs";\n'
        + replacements.reduce((text, [before, after]) => text.replaceAll(before, after), source);
}

export async function applyManagedPipeline(directory) {
    const file = path.join(directory, 'upstream/dist/indexer/pipeline.js');
    await fs.writeFile(file, managedPipelineSource(await fs.readFile(file, 'utf8')));
    return { id: 'neurocenter-rag-managed-index', version: 2, file: 'upstream/dist/indexer/pipeline.js' };
}
