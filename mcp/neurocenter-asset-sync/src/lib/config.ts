import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Нормализованное подмножество конфига `opencode-rag.json`.
 */
export interface IRagConfigCore {
    sourceFile: string;
    vectorStorePath: string | null;
    embedding: { provider: string; model: string; baseUrl: string | null };
    retrieval: { topK: number; minScore: number };
    indexing: { includeExtensionsCount: number; excludeDirsCount: number };
    mcpEnabled: boolean;
}

interface IRawConfig {
    vectorStore?: { path?: unknown };
    embedding?: Record<string, unknown>;
    retrieval?: Record<string, unknown>;
    indexing?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
}

/**
 * Читает и парсит `opencode-rag.json`, резолвит путь к векторному хранилищу и
 * возвращает нормализованное подмножество (embedding, retrieval, mcp).
 *
 * @param configPath - абсолютный путь к `opencode-rag.json`.
 * @returns ядро конфига или `null`, если файла нет / не JSON.
 */
export async function loadRagConfig(
    configPath: string,
): Promise<IRagConfigCore | null> {
    let raw: string;
    try {
        raw = await fs.readFile(configPath, 'utf8');
    } catch {
        return null;
    }

    let parsed: IRawConfig;
    try {
        parsed = JSON.parse(raw) as IRawConfig;
    } catch {
        return null;
    }

    const vspath =
    typeof parsed.vectorStore?.path === 'string'
        ? parsed.vectorStore.path
        : null;

    // vectorStore.path относительно локалоизирующего каталога конфига.
    const resolvedVectorStorePath = vspath
        ? path.resolve(path.dirname(configPath), vspath)
        : null;

    const emb = parsed.embedding ?? {};
    const ret = parsed.retrieval ?? {};
    const idx = parsed.indexing ?? {};

    return {
        sourceFile: configPath,
        vectorStorePath: resolvedVectorStorePath,
        embedding: {
            provider: typeof emb.provider === 'string' ? emb.provider : '',
            model: typeof emb.model === 'string' ? emb.model : '',
            baseUrl: typeof emb.baseUrl === 'string' ? emb.baseUrl : null,
        },
        retrieval: {
            topK: typeof ret.topK === 'number' ? ret.topK : 0,
            minScore: typeof ret.minScore === 'number' ? ret.minScore : 0,
        },
        indexing: {
            includeExtensionsCount: Array.isArray(idx.includeExtensions)
                ? idx.includeExtensions.length
                : 0,
            excludeDirsCount: Array.isArray(idx.excludeDirs)
                ? idx.excludeDirs.length
                : 0,
        },
        mcpEnabled: parsed.mcp?.enabled === true,
    };
}
