import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOpenCodeRagRuntime, prepareManagedRagCommands, RAG_DEPENDENCIES, RAG_VERSION, RAG_HOSTED_EMBEDDING } from './opencode-rag.mjs';
import { RAG_PLUGIN_SOURCE } from '../../../services/shared/opencode-rag-source.cjs';
import { managedPipelineSource } from './rag-managed-pipeline.mjs';
import { RAG_LOCAL_UI } from './rag-web-ui.mjs';

export const RAG_PLUGIN_REVISION = `${RAG_VERSION}-plugin.pack.9`;
export const RAG_PLUGIN_COMMIT = RAG_PLUGIN_SOURCE.commit;
export const RAG_PLUGIN_DEPENDENCIES = Object.freeze({ ...RAG_DEPENDENCIES, '@opencode-ai/plugin': '1.14.48' });
const original = 'const cfg = await getConfig(input.directory);';
const managed = 'const cfg = managedRagConfiguration(await getConfig(input.directory), readProjectRagConfiguration(findConfigFile(input.directory)), input.directory);';
const persistDimension = 'persistProbedDimension(configPath, vectorDimension);';
const replacements = [
    ['const effectiveCfg = applyRuntimeOverrides(cfg, overrides);', 'const effectiveCfg = applyHostedRagConfiguration(applyRuntimeOverrides(cfg, overrides), input.directory);'],
    [original, managed],
    [persistDimension, 'void vectorDimension; // Размерность остаётся в памяти; конфиг проекта не изменяется.'],
    ['const embedder = createEmbedder(effectiveCfg);', 'const embedder = protectedEmbedder(createEmbedder({ ...effectiveCfg, logging: { ...effectiveCfg.logging, level: "none" } }));'],
    ['const store = createVectorStore(effectiveCfg, storePath, vectorDimension);', 'const store = protectedNativeStore(createVectorStore(effectiveCfg, storePath, vectorDimension), { storePath, config: effectiveCfg, dimension: vectorDimension, embedder });'],
    ['    retrieve,\n};', '    retrieve: strictRetriever(retrieve),\n};'],
    ['output: "Search failed. The index may need to be rebuilt.",', 'output: nativeSearchFailure(err),'],
    ['const storePath = path.resolve(input.directory, cfg.vectorStore.path);', 'const storePath = path.resolve(input.directory, cfg.vectorStore.path);\n    await enterManagedSession(storePath);'],
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
    const imports = 'import { managedRagConfiguration, readProjectRagConfiguration, applyHostedRagConfiguration } from "../../rag-plugin-config.mjs";\n'
        + 'import { protectedEmbedder, strictRetriever } from "../../rag-errors.mjs";\n'
        + 'import { protectedNativeStore, nativeSearchFailure } from "../../rag-plugin-errors.mjs";\n'
        + 'import { enterManagedSession, leaveManagedSessions } from "../../rag-index-lock.mjs";\n';
    await fs.writeFile(file, imports + replacements.reduce((text, [before, after]) => text.replace(before, after), source));
    await fs.writeFile(pipelineFile, guardedPipeline);
    return { id: 'neurocenter-opencode1-plugin-configuration', version: 4, file: 'upstream/dist/plugin.js', files: ['upstream/dist/plugin.js', 'upstream/dist/indexer/pipeline.js'] };
}

/** Родные инструменты и hooks upstream через совместимую фабрику OpenCode 1, без V2/TUI. */
export async function prepareOpenCodeRagPlugin(context) {
    const upstream = await prepareOpenCodeRagRuntime({ ...context, dependencies: RAG_PLUGIN_DEPENDENCIES, lock: 'opencode-rag-plugin.json' });
    const uiPatch = await prepareManagedRagCommands(context.directory);
    for (const name of ['rag-plugin.mjs']) {
        await fs.copyFile(fileURLToPath(new URL('./adapters/' + name, import.meta.url)), path.join(context.directory, name));
    }
    const patch = await applyManagedPluginCompatibility(context.directory);
    return { entrypoint: 'rag-plugin.mjs', kind: 'plugin', mode: 'plugin', config: { entrypoint: 'rag-plugin.mjs', extra: { localUi: RAG_LOCAL_UI, hostedEmbedding: RAG_HOSTED_EMBEDDING } },
        upstream: { ...upstream, repository: 'https://github.com/MrDoe/OpenCodeRAG', commit: RAG_PLUGIN_COMMIT,
            sdk: { package: '@opencode-ai/plugin', version: RAG_PLUGIN_DEPENDENCIES['@opencode-ai/plugin'] }, compatibilityPatches: [patch, uiPatch] },
        limitations: ['Настоящий Web UI, инструменты и hooks через совместимую фабрику OpenCode 1; V2/TUI не подключаются.'] };
}
