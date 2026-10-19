import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { handleSearchSemantic, handleFileSkeleton, handleFindUsages } from './upstream/dist/mcp/handlers.js';
import { runIndexPass, getIndexStatusSummary } from './upstream/dist/indexer/pipeline.js';
import { destroyAllPooledConnections } from './upstream/dist/embedder/http.js';
import { retrieve } from './upstream/dist/retriever/retriever.js';
import { readRagConfiguration, createRagContext, checkedWorkspacePath } from './rag-context.mjs';
import { protectedEmbedder, strictRetriever, requireSuccessfulIndex } from './rag-errors.mjs';
import { enterManagedSession, leaveManagedSessions } from './rag-index-lock.mjs';

const root = await fs.realpath(process.cwd());
const config = await readRagConfiguration(root);
const server = new McpServer({ name: 'neurocenter-opencode-rag', version: '2.4.4' });
let pendingContext;
let indexing = false;
let context;
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const retrieveStrict = strictRetriever(retrieve);
const tool = handler => async (...args) => {
    try { return text(await handler(...args)); }
    catch (error) { return { ...text(error.indexStats ? { ...error.indexStats, message: error.message } : error.message), isError: true }; }
};
async function getContext() {
    if (!pendingContext) pendingContext = (async () => {
        await enterManagedSession(await checkedWorkspacePath(root, config.vectorStore.path));
        return createRagContext(root, config);
    })().then(value => {
        value.embedder = protectedEmbedder(value.embedder);
        return (context = value);
    }).catch(async error => { pendingContext = undefined; await leaveManagedSessions(); throw error; });
    return pendingContext;
}

server.tool('search_semantic', 'Поиск по смыслу в локальном индексе. Для первого индекса вызовите index_project.', {
    query: z.string().min(1), pathHints: z.array(z.string()).max(10).optional(), languageHints: z.array(z.string()).max(10).optional(),
    fileExtensions: z.array(z.string()).max(10).optional(), topK: z.number().int().min(1).max(25).optional(),
}, tool(async args => { const ctx = await getContext(); return (await handleSearchSemantic(args, ctx.embedder, ctx.store, config, ctx.keywordIndex, retrieveStrict)).formatted; }));
server.tool('get_file_skeleton', 'Структура исходного файла только внутри связанной папки проекта.', { filePath: z.string().min(1) },
    tool(async args => {
        const filePath = await checkedWorkspacePath(root, args.filePath);
        return (await handleFileSkeleton({ filePath }, root, config.chunking?.parsers)).formatted;
    }));
server.tool('find_usages', 'Поиск использований символа в локальном индексе проекта.', {
    symbolName: z.string().min(1), pathHint: z.string().optional(), topK: z.number().int().min(1).max(50).optional(),
}, tool(async args => { const ctx = await getContext(); return (await handleFindUsages(args, ctx.embedder, ctx.store, config, ctx.keywordIndex, retrieveStrict)).formatted; }));
server.registerTool('index_project', { description: 'Создать или обновить локальный индекс связанной папки. Код отправляется только настроенному провайдеру эмбеддингов. Путь проекта изменить нельзя.', inputSchema: z.object({}).strict() },
    tool(async (_args, extra) => {
        if (indexing) throw new Error('Индексирование уже выполняется.');
        indexing = true;
        try {
            const ctx = await getContext();
            await checkedWorkspacePath(root, ctx.storePath);
            return requireSuccessfulIndex(await runIndexPass({ cwd: root, storePath: ctx.storePath, config, store: ctx.store, embedder: ctx.embedder,
                keywordIndex: ctx.keywordIndex, dimension: ctx.dimension, abortSignal: extra.signal }));
        } finally { indexing = false; }
    }));
server.registerTool('get_index_status', { description: 'Состояние локального индекса без перестроения.', inputSchema: z.object({}).strict() }, tool(async () => {
    const ctx = await getContext();
    return getIndexStatusSummary(root, ctx.storePath, config, ctx.store, true);
}));

let closing;
const close = () => closing ||= (async () => {
    try {
        await server.close();
        destroyAllPooledConnections();
        await pendingContext?.catch(() => undefined);
        if (context) { try { await context.store.close(); } finally { context.keywordIndex.close(); } }
    } finally { destroyAllPooledConnections(); await leaveManagedSessions(); }
})();
const shutdown = () => { void close().then(() => process.exit(process.exitCode || 0), () => process.exit(1)); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
await server.connect(new StdioServerTransport());
process.stdin.once('end', shutdown);
process.stdin.once('close', shutdown);
