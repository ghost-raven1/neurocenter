import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Нормализованное подмножество конфига `opencode-rag.json`.
 */
export interface IRagConfigCore {
    sourceFile: string;
    vectorStorePath: string | null;
    embedding: { provider: string; model: string; baseUrl: string | null; vectorDimension?: number };
    /** Только явно заданные публичные поля; секреты не копируются в контракт. */
    embeddingInput?: Record<string, unknown>;
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
    projectRoot = path.dirname(configPath),
): Promise<IRagConfigCore | null> {
    let raw: string;
    try {
        raw = await fs.readFile(configPath, 'utf8');
    } catch {
        return null;
    }

    let parsed: IRawConfig;
    try {
        parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as IRawConfig;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
    } catch {
        return null;
    }

    const vspath = typeof parsed.vectorStore?.path === 'string' ? parsed.vectorStore.path : null;

    // OpenCodeRAG разрешает относительный путь от корня проекта для всех трёх конфигов.
    const resolvedVectorStorePath = vspath ? path.resolve(projectRoot, vspath) : null;

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
            vectorDimension: typeof emb.vectorDimension === 'number' ? emb.vectorDimension : undefined,
        },
        embeddingInput: Object.fromEntries(
            ['provider', 'model', 'baseUrl', 'vectorDimension']
                .filter((key) => Object.hasOwn(emb, key))
                .map((key) => [key, emb[key]]),
        ),
        retrieval: {
            topK: typeof ret.topK === 'number' ? ret.topK : 0,
            minScore: typeof ret.minScore === 'number' ? ret.minScore : 0,
        },
        indexing: {
            includeExtensionsCount: Array.isArray(idx.includeExtensions) ? idx.includeExtensions.length : 0,
            excludeDirsCount: Array.isArray(idx.excludeDirs) ? idx.excludeDirs.length : 0,
        },
        mcpEnabled: parsed.mcp?.enabled === true,
    };
}
