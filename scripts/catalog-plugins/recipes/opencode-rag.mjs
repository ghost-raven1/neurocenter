import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, extract, installDependencies, TARGETS } from './upstream.mjs';
import { applyManagedWebUiCompatibility, RAG_LOCAL_UI } from './rag-web-ui.mjs';
import { applyManagedPipeline } from './rag-managed-pipeline.mjs';

export const RAG_HOSTED_EMBEDDING = Object.freeze({ schemaVersion: 1, profileSchemaVersion: 2, reindexSchemaVersion: 1 });
export const RAG_VERSION = '2.4.4';
export const RAG_REVISION = `${RAG_VERSION}-mcp.pack.11`;
export const RAG_SUPPORTED_TARGETS = Object.freeze(Object.keys(TARGETS).filter(target => target !== 'darwin-x64'));
const sha256 = '6a21f4e39748394e56400364990f90ae0c9518cf6d16f62623fe664a951358af';
// V2/TUI зависимости исключены; настоящий Web UI уже собран в закреплённом upstream-архиве.
export const RAG_DEPENDENCIES = Object.freeze({
    '@e965/xlsx': '0.20.3', '@lancedb/lancedb': '0.29.0', '@modelcontextprotocol/sdk': '1.29.0',
    '@thednp/dommatrix': '3.0.4', '@vscode/tree-sitter-wasm': '0.3.1', 'apache-arrow': '18.1.0',
    chokidar: '4.0.3', commander: '13.1.0', 'js-tiktoken': '1.0.21', mammoth: '1.12.0',
    minimatch: '8.0.7', 'p-limit': '7.3.0', 'pdfjs-dist': '6.3.289', picocolors: '1.1.1',
    sharp: '0.35.2', 'web-tree-sitter': '0.26.9', 'word-extractor': '1.0.4',
});

export const RAG_LOCAL_CONFIGURATION = Object.freeze({ schemaVersion: 1, fields: [
    { id: 'embeddingUrl', label: 'URL эмбеддингов (Ollama /api или OpenAI /v1; код отправляется на этот адрес)', type: 'url', required: true,
        target: { kind: 'env', name: 'NEUROCENTER_RAG_EMBEDDING_URL' } },
    { id: 'embeddingModel', label: 'Модель эмбеддингов', type: 'string', required: true,
        target: { kind: 'env', name: 'NEUROCENTER_RAG_EMBEDDING_MODEL' } },
    { id: 'embeddingProvider', label: 'Протокол: ollama или openai (по умолчанию ollama)', type: 'string', required: false,
        target: { kind: 'env', name: 'NEUROCENTER_RAG_EMBEDDING_PROVIDER' } },
    { id: 'embeddingKey', label: 'API-ключ эмбеддингов (для OpenAI; локальный сервер может принимать любое значение)', type: 'string', required: false, secret: true,
        target: { kind: 'env', name: 'NEUROCENTER_RAG_EMBEDDING_KEY' } },
] });

/** Общее закреплённое ядро MCP и плагина; зависимости устанавливаются только на площадке. */
export async function prepareOpenCodeRagRuntime({ target, directory, dependencies = RAG_DEPENDENCIES, lock = 'opencode-rag.json' }) {
    if (!RAG_SUPPORTED_TARGETS.includes(target)) {
        throw new Error(target === 'darwin-x64' ? 'OpenCodeRAG: upstream LanceDB 0.29.0 не публикует native runtime для Intel Mac.' : 'Неизвестная платформа: ' + target);
    }
    await fs.mkdir(directory, { recursive: true });
    const archive = await download('https://registry.npmjs.org/opencode-rag-plugin/-/opencode-rag-plugin-2.4.4.tgz', sha256);
    const temporary = await fs.mkdtemp(path.join(path.dirname(directory), 'rag-source-'));
    try {
        await extract(archive, temporary);
        await fs.cp(path.join(temporary, 'package'), path.join(directory, 'upstream'), { recursive: true });
        await fs.copyFile(fileURLToPath(new URL('../locks/' + lock, import.meta.url)), path.join(directory, 'package-lock.json'));
        await installDependencies(directory, dependencies, target);
        return { version: RAG_VERSION, archiveSha256: sha256 };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

/** Сохраняет private identity после известного upstream structuredClone без записи project config. */
export async function applyHostedRuntimeCompatibility(directory) {
    const file = path.join(directory, 'upstream/dist/core/runtime-overrides.js');
    const source = await fs.readFile(file, 'utf8');
    if (source.split('    return merged;').length !== 2 || source.includes('preserveHostedRagConfiguration')) throw new Error('Изменилась обработка runtime overrides OpenCodeRAG; обновите адаптер.');
    await fs.writeFile(file, 'import { preserveHostedRagConfiguration } from "../../../rag-hosted.mjs";\n' + source.replace('    return merged;', '    return preserveHostedRagConfiguration(cfg, merged);'));
    return { id: 'neurocenter-rag-hosted-configuration', version: 1, file: 'upstream/dist/core/runtime-overrides.js' };
}

/** Общие управляемые команды сохраняют одни настройки и блокировки MCP, плагина и Web UI. */
export async function prepareManagedRagCommands(directory) {
    for (const name of ['opencode-rag.mjs', 'rag-mcp.mjs', 'rag-context.mjs', 'rag-errors.mjs', 'rag-local-runtime.mjs',
        'rag-ui.mjs', 'rag-reindex.mjs', 'rag-reindex-source.mjs', 'rag-ui-guards.mjs', 'rag-ui-config.mjs', 'rag-plugin-errors.mjs', 'rag-index-lock.mjs']) {
        await fs.copyFile(fileURLToPath(new URL('./adapters/' + name, import.meta.url)), path.join(directory, name));
    }
    for (const name of ['rag-index-profile.mjs', 'rag-plugin-config.mjs', 'rag-hosted.mjs']) {
        const helper = await fs.readFile(fileURLToPath(new URL('./adapters/' + name, import.meta.url)), 'utf8');
        if (helper.split('../../../../services/shared/rag-index-contract.cjs').length !== 2) throw new Error('Изменилась зависимость RAG helper.');
        await fs.writeFile(path.join(directory, name), helper.replace('../../../../services/shared/rag-index-contract.cjs', './rag-index-contract.cjs'));
    }
    await fs.copyFile(fileURLToPath(new URL('../../../services/shared/rag-index-contract.cjs', import.meta.url)), path.join(directory, 'rag-index-contract.cjs'));
    const hostedEmbedding = await applyHostedRuntimeCompatibility(directory);
    return { ...await applyManagedWebUiCompatibility(directory), hostedEmbedding };
}

/** Автономная поставка upstream MCP с явным индексированием и локальной настройкой модели. */
export async function prepareOpenCodeRag(context) {
    const upstream = await prepareOpenCodeRagRuntime(context);
    const uiPatch = await prepareManagedRagCommands(context.directory);
    const pipelinePatch = await applyManagedPipeline(context.directory);
    return { entrypoint: 'opencode-rag.mjs', kind: 'mcp', mode: 'mcp',
        config: { transport: 'stdio', command: 'node', entrypoint: 'opencode-rag.mjs', args: ['mcp'], extra: { localConfiguration: RAG_LOCAL_CONFIGURATION, localUi: RAG_LOCAL_UI, hostedEmbedding: RAG_HOSTED_EMBEDDING } },
        upstream: { ...upstream, compatibilityPatches: [uiPatch, pipelinePatch] },
        limitations: ['Настоящий Web UI и MCP; без TUI и автоматических hooks OpenCode V2.', 'Индекс создаётся только явным вызовом index_project или через Web UI при закрытых сессиях.'] };
}
