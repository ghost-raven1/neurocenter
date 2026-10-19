import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOpenCodeRagRuntime, RAG_DEPENDENCIES, RAG_VERSION } from './opencode-rag.mjs';
import { RAG_PLUGIN_SOURCE } from '../../../services/shared/opencode-rag-source.cjs';

export const RAG_PLUGIN_REVISION = `${RAG_VERSION}-plugin.pack.3`;
export const RAG_PLUGIN_COMMIT = RAG_PLUGIN_SOURCE.commit;
export const RAG_PLUGIN_DEPENDENCIES = Object.freeze({ ...RAG_DEPENDENCIES, '@opencode-ai/plugin': '1.14.48' });
const original = 'const cfg = await getConfig(input.directory);';
const managed = 'const cfg = managedRagConfiguration(await getConfig(input.directory), Boolean(findConfigFile(input.directory)));';
const persistDimension = 'persistProbedDimension(configPath, vectorDimension);';
const replacements = [
    [original, managed],
    [persistDimension, 'void vectorDimension; // Размерность остаётся в памяти; конфиг проекта не изменяется.'],
    ['const embedder = createEmbedder(effectiveCfg);', 'const embedder = protectedEmbedder(createEmbedder({ ...effectiveCfg, logging: { ...effectiveCfg.logging, level: "none" } }));'],
    ['const store = createVectorStore(effectiveCfg, storePath, vectorDimension);', 'const store = protectedNativeStore(createVectorStore(effectiveCfg, storePath, vectorDimension));'],
    ['    retrieve,\n};', '    retrieve: strictRetriever(retrieve),\n};'],
    ['output: "Search failed. The index may need to be rebuilt.",', 'output: nativeSearchFailure(err),'],
];

/** Меняет только инициализацию известной upstream-фабрики; другой исходник требует новой ревизии адаптера. */
export async function applyManagedPluginCompatibility(directory) {
    const file = path.join(directory, 'upstream/dist/plugin.js');
    const source = await fs.readFile(file, 'utf8');
    if (replacements.some(([before]) => source.split(before).length !== 2) || source.includes('managedRagConfiguration')) {
        throw new Error('Изменилась точка инициализации OpenCodeRAG; требуется обновить адаптер плагина.');
    }
    const imports = 'import { managedRagConfiguration } from "../../rag-plugin-config.mjs";\n'
        + 'import { protectedEmbedder, strictRetriever } from "../../rag-errors.mjs";\n'
        + 'import { protectedNativeStore, nativeSearchFailure } from "../../rag-plugin-errors.mjs";\n';
    await fs.writeFile(file, imports + replacements.reduce((text, [before, after]) => text.replace(before, after), source));
    return { id: 'neurocenter-opencode1-plugin-configuration', version: 2, file: 'upstream/dist/plugin.js' };
}

/** Родные инструменты и hooks upstream через совместимую фабрику OpenCode 1, без V2/TUI. */
export async function prepareOpenCodeRagPlugin(context) {
    const upstream = await prepareOpenCodeRagRuntime({ ...context, dependencies: RAG_PLUGIN_DEPENDENCIES, lock: 'opencode-rag-plugin.json' });
    for (const name of ['rag-plugin.mjs', 'rag-plugin-config.mjs', 'rag-local-runtime.mjs', 'rag-plugin-errors.mjs', 'rag-errors.mjs']) {
        await fs.copyFile(fileURLToPath(new URL('./adapters/' + name, import.meta.url)), path.join(context.directory, name));
    }
    const patch = await applyManagedPluginCompatibility(context.directory);
    return { entrypoint: 'rag-plugin.mjs', kind: 'plugin', mode: 'plugin', config: { entrypoint: 'rag-plugin.mjs' },
        upstream: { ...upstream, repository: 'https://github.com/MrDoe/OpenCodeRAG', commit: RAG_PLUGIN_COMMIT,
            sdk: { package: '@opencode-ai/plugin', version: RAG_PLUGIN_DEPENDENCIES['@opencode-ai/plugin'] }, compatibilityPatches: [patch] },
        limitations: ['Инструменты и hooks через совместимую фабрику OpenCode 1; V2/TUI не подключаются.'] };
}
