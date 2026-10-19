import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, extract, installDependencies, TARGETS } from './upstream.mjs';

export const RAG_VERSION = '2.4.4';
export const RAG_REVISION = `${RAG_VERSION}-mcp.pack.4`;
export const RAG_SUPPORTED_TARGETS = Object.freeze(Object.keys(TARGETS).filter(target => target !== 'darwin-x64'));
const sha256 = '6a21f4e39748394e56400364990f90ae0c9518cf6d16f62623fe664a951358af';
// V2/TUI зависимости исключены: этот комплект запускает MCP, а не неподдерживаемый V2 plugin.
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

/** Автономная поставка upstream MCP с явным индексированием и локальной настройкой модели. */
export async function prepareOpenCodeRag({ target, directory }) {
    if (!RAG_SUPPORTED_TARGETS.includes(target)) {
        throw new Error(target === 'darwin-x64' ? 'OpenCodeRAG: upstream LanceDB 0.29.0 не публикует native runtime для Intel Mac.' : 'Неизвестная платформа: ' + target);
    }
    await fs.mkdir(directory, { recursive: true });
    const archive = await download('https://registry.npmjs.org/opencode-rag-plugin/-/opencode-rag-plugin-2.4.4.tgz', sha256);
    const temporary = await fs.mkdtemp(path.join(path.dirname(directory), 'rag-source-'));
    try {
        await extract(archive, temporary);
        await fs.cp(path.join(temporary, 'package'), path.join(directory, 'upstream'), { recursive: true });
        await fs.copyFile(fileURLToPath(new URL('../locks/opencode-rag.json', import.meta.url)), path.join(directory, 'package-lock.json'));
        await installDependencies(directory, RAG_DEPENDENCIES, target);
        for (const name of ['rag-mcp.mjs', 'rag-context.mjs', 'rag-errors.mjs', 'rag-local-runtime.mjs']) {
            await fs.copyFile(fileURLToPath(new URL('./adapters/' + name, import.meta.url)), path.join(directory, name));
        }
        return { entrypoint: 'rag-mcp.mjs', kind: 'mcp', mode: 'mcp',
            config: { transport: 'stdio', command: 'node', entrypoint: 'rag-mcp.mjs', args: [], extra: { localConfiguration: RAG_LOCAL_CONFIGURATION } },
            upstream: { version: RAG_VERSION, archiveSha256: sha256 },
            limitations: ['MCP tools; без TUI и автоматических hooks OpenCode V2.', 'Индекс создаётся только явным вызовом index_project.'] };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
