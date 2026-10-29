import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOpenCodeRagRuntime, prepareManagedRagCommands, RAG_DEPENDENCIES, RAG_VERSION, RAG_HOSTED_EMBEDDING, RAG_LEARNING_QUIRKS } from './opencode-rag.mjs';
import { RAG_PLUGIN_SOURCE } from '../../../services/shared/opencode-rag-source.cjs';
import { managedPipelineSource } from './rag-managed-pipeline.mjs';
import { RAG_LOCAL_UI } from './rag-web-ui.mjs';

export const RAG_PLUGIN_REVISION = `${RAG_VERSION}-plugin.pack.1`;
export const RAG_PLUGIN_COMMIT = RAG_PLUGIN_SOURCE.commit;
export const RAG_PLUGIN_DEPENDENCIES = Object.freeze({ ...RAG_DEPENDENCIES, '@opencode-ai/plugin': '1.14.48' });
const original = 'const cfg = await getConfig(input.directory);';
const managed = 'const cfg = managedRagConfiguration(await getConfig(input.directory), readWorkspaceRagConfiguration(resolveConfigPaths(input.directory)), input.directory);';
const persistDimension = 'persistProbedDimension(configPath, vectorDimension);';
const replacements = [
    ['const effectiveCfg = applyRuntimeOverrides(cfg, overrides);', 'const effectiveCfg = applyHostedRagConfiguration(applyRuntimeOverrides(cfg, overrides), input.directory);'],
    [original, managed],
    ['lastEffectiveCfg = applyRuntimeOverrides(refreshConfig(options.worktree, options.cfg), cachedOverrides);', 'lastEffectiveCfg = managedRagConfiguration(applyRuntimeOverrides(refreshConfig(options.worktree, options.cfg), cachedOverrides), readWorkspaceRagConfiguration(resolveConfigPaths(options.worktree)), options.worktree);'],
    ['return applyRuntimeOverrides(loadWorkspaceConfig(options.worktree, false), cachedOverrides);', 'return managedRagConfiguration(applyRuntimeOverrides(loadWorkspaceConfig(options.worktree, false), cachedOverrides), readWorkspaceRagConfiguration(resolveConfigPaths(options.worktree)), options.worktree);'],
    ['const liveEmbedder = createLiveEmbedder(() => refreshConfig(input.directory, effectiveCfg), (cfg) => createEmbedder(cfg), embedder);', 'const liveEmbedder = createLiveEmbedder(() => managedRagConfiguration(refreshConfig(input.directory, effectiveCfg), readWorkspaceRagConfiguration(resolveConfigPaths(input.directory)), input.directory), cfg => protectedEmbedder(createEmbedder({ ...cfg, logging: { ...cfg.logging, level: \"none\" } }), cfg), embedder);'],
    [persistDimension, 'void vectorDimension; // Размерность остаётся в памяти; конфиг проекта не изменяется.'],
    ['const embedder = createEmbedder(effectiveCfg);', 'const embedder = protectedEmbedder(createEmbedder({ ...effectiveCfg, logging: { ...effectiveCfg.logging, level: "none" } }), effectiveCfg);'],
    ['const store = createVectorStore(effectiveCfg, storePath, vectorDimension, input.directory);', 'const store = protectedNativeStore(createVectorStore(effectiveCfg, storePath, vectorDimension, input.directory), { storePath, config: effectiveCfg, dimension: vectorDimension, embedder });'],
    ['    retrieve,\n};', '    retrieve: strictRetriever(retrieve),\n};'],
    ['output: "Search failed. The index may need to be rebuilt.",', 'output: nativeSearchFailure(err),'],
    ['const storePath = path.resolve(input.directory, cfg.vectorStore.path);', 'const storePath = path.resolve(input.directory, cfg.vectorStore.path);\n    assertManagedQuirksSource(storePath);\n    await enterManagedSession(storePath);'],
    ['notifiedUpdateDirs.clear();\n    destroyAllPooledConnections();', 'notifiedUpdateDirs.clear();\n    destroyAllPooledConnections();\n    await leaveManagedSessions();'],
];

/** Меняет только инициализацию известной upstream-фабрики; другой исходник требует новой ревизии адаптера. */
export async function applyManagedPluginCompatibility(directory) {
    const file = path.join(directory, 'upstream/dist/plugin.js');
    const source = await fs.readFile(file, 'utf8');
    const pipelineFile = path.join(directory, 'upstream/dist/indexer/pipeline.js');
    const pipeline = await fs.readFile(pipelineFile, 'utf8');
    if (replacements.some(([before]) => source.split(before).length !== 2) || source.includes('managedRagConfiguration')) {
        throw new Error('Изменилась точка инициализации OpenCodeRAG; требуется обновить адаптер плагина.');
    }
    const guardedPipeline = managedPipelineSource(pipeline);
    const imports = 'import { managedRagConfiguration, readWorkspaceRagConfiguration, applyHostedRagConfiguration } from "../../rag-plugin-config.mjs";\n'
        + 'import { assertManagedQuirksSource } from \"../../rag-quirks-guard.mjs\";\n'
        + 'import { protectedEmbedder, strictRetriever } from "../../rag-errors.mjs";\n'
        + 'import { protectedNativeStore, nativeSearchFailure } from "../../rag-plugin-errors.mjs";\n'
        + 'import { enterManagedSession, leaveManagedSessions } from "../../rag-index-lock.mjs";\n';
    await fs.writeFile(file, imports + replacements.reduce((text, [before, after]) => text.replace(before, after), source));
    await fs.writeFile(pipelineFile, guardedPipeline);
    return { id: 'neurocenter-opencode1-plugin-configuration', version: 5, file: 'upstream/dist/plugin.js', files: ['upstream/dist/plugin.js', 'upstream/dist/indexer/pipeline.js'] };
}

/** Родные инструменты и hooks upstream через совместимую фабрику OpenCode 1, без V2/TUI. */
export async function prepareOpenCodeRagPlugin(context) {
    const upstream = await prepareOpenCodeRagRuntime({ ...context, dependencies: RAG_PLUGIN_DEPENDENCIES, lock: 'opencode-rag-plugin.json' });
    const uiPatch = await prepareManagedRagCommands(context.directory);
    for (const name of ['rag-plugin.mjs']) {
        await fs.copyFile(fileURLToPath(new URL('./adapters/' + name, import.meta.url)), path.join(context.directory, name));
    }
    const patch = await applyManagedPluginCompatibility(context.directory);
    return { entrypoint: 'rag-plugin.mjs', kind: 'plugin', mode: 'plugin', config: { entrypoint: 'rag-plugin.mjs', extra: { localUi: RAG_LOCAL_UI, hostedEmbedding: RAG_HOSTED_EMBEDDING, learningQuirks: RAG_LEARNING_QUIRKS } },
        upstream: { ...upstream, repository: 'https://github.com/MrDoe/OpenCodeRAG', commit: RAG_PLUGIN_COMMIT,
            sdk: { package: '@opencode-ai/plugin', version: RAG_PLUGIN_DEPENDENCIES['@opencode-ai/plugin'] }, compatibilityPatches: [patch, uiPatch] },
        limitations: ['Настоящий Web UI, инструменты и hooks через совместимую фабрику OpenCode 1; V2/TUI не подключаются.'] };
}
