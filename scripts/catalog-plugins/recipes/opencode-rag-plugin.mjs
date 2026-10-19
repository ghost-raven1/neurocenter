import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOpenCodeRagRuntime, RAG_DEPENDENCIES, RAG_VERSION } from './opencode-rag.mjs';
import { RAG_PLUGIN_SOURCE } from '../../../services/shared/opencode-rag-source.cjs';

export const RAG_PLUGIN_REVISION = `${RAG_VERSION}-plugin.pack.4`;
export const RAG_PLUGIN_COMMIT = RAG_PLUGIN_SOURCE.commit;
export const RAG_PLUGIN_DEPENDENCIES = Object.freeze({ ...RAG_DEPENDENCIES, '@opencode-ai/plugin': '1.14.48' });
const original = 'const cfg = await getConfig(input.directory);';
const managed = 'const cfg = managedRagConfiguration(await getConfig(input.directory), readProjectRagConfiguration(findConfigFile(input.directory)));';
const persistDimension = 'persistProbedDimension(configPath, vectorDimension);';
const replacements = [
    [original, managed],
    [persistDimension, 'void vectorDimension; // Размерность остаётся в памяти; конфиг проекта не изменяется.'],
    ['const embedder = createEmbedder(effectiveCfg);', 'const embedder = protectedEmbedder(createEmbedder({ ...effectiveCfg, logging: { ...effectiveCfg.logging, level: "none" } }));'],
    ['const store = createVectorStore(effectiveCfg, storePath, vectorDimension);', 'const store = protectedNativeStore(createVectorStore(effectiveCfg, storePath, vectorDimension), { storePath, config: effectiveCfg, dimension: vectorDimension, embedder });'],
    ['    retrieve,\n};', '    retrieve: strictRetriever(retrieve),\n};'],
    ['output: "Search failed. The index may need to be rebuilt.",', 'output: nativeSearchFailure(err),'],
    ['const storePath = path.resolve(input.directory, cfg.vectorStore.path);', 'const storePath = path.resolve(input.directory, cfg.vectorStore.path);\n    await enterManagedSession(storePath);'],
    ['notifiedUpdateDirs.clear();\n    destroyAllPooledConnections();', 'notifiedUpdateDirs.clear();\n    destroyAllPooledConnections();\n    await leaveManagedSessions();'],
];
const pipelineReplacements = [
    ['return await runIndexPassInner(options, logger);', 'return await withManagedIndexProfile(options, next => runIndexPassInner(next, logger));'],
    ['if (!tempStoreWroteChunks) {', 'if (!tempStoreWroteChunks || stats.embeddingUnavailable || stats.embeddingFailures > 0 || stats.extractionFailures > 0 || stats.descriptionFailedFiles > 0) {'],
    ['await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");', 'if (!await acquireManagedIndexLock(lockPath)) return { ...createIndexStats(0, "missing"), skipped: true };'],
    ['logger.debug(`Could not write index lock file: ${err.message} — concurrent-pass protection disabled`);', 'return { ...createIndexStats(0, "missing"), skipped: true }; // Не перезаписываем чужой lock и не работаем без него.'],
    ['await fs.unlink(lockPath);', 'await releaseManagedIndexLock(lockPath);'],
    ['await swapStoreDirectories(tempStorePath, options.storePath);', 'await fs.copyFile(path.join(options.storePath, LOCK_FILE), path.join(tempStorePath, LOCK_FILE), 1); // COPYFILE_EXCL: lock сохраняется при promotion.\n                    await preserveManagedSessionLock(options.storePath, tempStorePath);\n                    await swapStoreDirectories(tempStorePath, options.storePath);'],
];

/** Меняет только инициализацию известной upstream-фабрики; другой исходник требует новой ревизии адаптера. */
export async function applyManagedPluginCompatibility(directory) {
    const file = path.join(directory, 'upstream/dist/plugin.js');
    const source = await fs.readFile(file, 'utf8');
    const pipelineFile = path.join(directory, 'upstream/dist/indexer/pipeline.js');
    const pipeline = await fs.readFile(pipelineFile, 'utf8');
    if (replacements.some(([before]) => source.split(before).length !== 2) || source.includes('managedRagConfiguration')
        || pipelineReplacements.some(([before]) => pipeline.split(before).length !== 2) || pipeline.includes('withManagedIndexProfile')) {
        throw new Error('Изменилась точка инициализации OpenCodeRAG; требуется обновить адаптер плагина.');
    }
    const imports = 'import { managedRagConfiguration, readProjectRagConfiguration } from "../../rag-plugin-config.mjs";\n'
        + 'import { protectedEmbedder, strictRetriever } from "../../rag-errors.mjs";\n'
        + 'import { protectedNativeStore, nativeSearchFailure } from "../../rag-plugin-errors.mjs";\n'
        + 'import { enterManagedSession, leaveManagedSessions } from "../../rag-index-lock.mjs";\n';
    await fs.writeFile(file, imports + replacements.reduce((text, [before, after]) => text.replace(before, after), source));
    await fs.writeFile(pipelineFile, 'import { withManagedIndexProfile } from "../../../rag-index-profile.mjs";\n'
        + 'import { acquireManagedIndexLock, releaseManagedIndexLock, preserveManagedSessionLock } from "../../../rag-index-lock.mjs";\n'
        + pipelineReplacements.reduce((text, [before, after]) => text.replace(before, after), pipeline));
    return { id: 'neurocenter-opencode1-plugin-configuration', version: 3, file: 'upstream/dist/plugin.js', files: ['upstream/dist/plugin.js', 'upstream/dist/indexer/pipeline.js'] };
}

/** Родные инструменты и hooks upstream через совместимую фабрику OpenCode 1, без V2/TUI. */
export async function prepareOpenCodeRagPlugin(context) {
    const upstream = await prepareOpenCodeRagRuntime({ ...context, dependencies: RAG_PLUGIN_DEPENDENCIES, lock: 'opencode-rag-plugin.json' });
    for (const name of ['rag-plugin.mjs', 'rag-local-runtime.mjs', 'rag-plugin-errors.mjs', 'rag-errors.mjs', 'rag-index-lock.mjs']) {
        await fs.copyFile(fileURLToPath(new URL('./adapters/' + name, import.meta.url)), path.join(context.directory, name));
    }
    for (const name of ['rag-index-profile.mjs', 'rag-plugin-config.mjs']) {
        const helper = await fs.readFile(fileURLToPath(new URL('./adapters/' + name, import.meta.url)), 'utf8');
        if (helper.split('../../../../services/shared/rag-index-contract.cjs').length !== 2) throw new Error('Изменилась зависимость RAG helper.');
        await fs.writeFile(path.join(context.directory, name), helper.replace('../../../../services/shared/rag-index-contract.cjs', './rag-index-contract.cjs'));
    }
    await fs.copyFile(fileURLToPath(new URL('../../../services/shared/rag-index-contract.cjs', import.meta.url)), path.join(context.directory, 'rag-index-contract.cjs'));
    const patch = await applyManagedPluginCompatibility(context.directory);
    return { entrypoint: 'rag-plugin.mjs', kind: 'plugin', mode: 'plugin', config: { entrypoint: 'rag-plugin.mjs' },
        upstream: { ...upstream, repository: 'https://github.com/MrDoe/OpenCodeRAG', commit: RAG_PLUGIN_COMMIT,
            sdk: { package: '@opencode-ai/plugin', version: RAG_PLUGIN_DEPENDENCIES['@opencode-ai/plugin'] }, compatibilityPatches: [patch] },
        limitations: ['Инструменты и hooks через совместимую фабрику OpenCode 1; V2/TUI не подключаются.'] };
}
