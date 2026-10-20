export interface IUpsertRow {
    id: string;
    filePath: string;
    content: string;
    description: string | null;
    startLine: number | null;
    endLine: number | null;
    language: string | null;
    kind: string;
    role: string | null;
    quirkType: string | null;
    tags: string | null;
    contentHash: string;
    embedding: number[] | null;
    syncHash?:string|null;
}


/**
 * Преобразует эмбеддинг из postgres в плоский массив чисел. pg отдаёт
 * вектор как строку `'[0.1,0.2,…]'`; если уже массив — возвращает как есть.
 *
 * @param v - сырое значение колонки embedding.
 * @returns {number[] | null}
 */
export function parseVector(v: string | number[] | null): number[] | null {
    if (v == null) {
        return null;
    }
    if (typeof v === 'string') {
        const trimmed = v.trim();
        if (trimmed === '' || (trimmed[0] !== '[' && trimmed[trimmed.length - 1] !== ']')) {
            return null;
        }
        try {
            return JSON.parse(trimmed) as number[];
        } catch {
            return null;
        }
    }
    return v;
}

function vectorLiteral(v: number[] | null): string | null {
    if (v == null) {
        return null;
    }
    return `[${v.join(',')}]`;
}

/**
 * Собирает многострочный upsert `INSERT ... VALUES (...), ... ON CONFLICT DO UPDATE`
 * с параметризованными плейсхолдерами (эмбеддинг — строка `'[...]'`::vector).
 */
export function buildUpsert(
    projectKey: string,
    generation:string,
    rows: IUpsertRow[],
): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const push = (v: unknown): string => {
        params.push(v);
        return `$${params.length}`;
    };
    const tuples: string[] = rows.map((r) => {
        const emb = vectorLiteral(r.embedding);
        return (
            `(${push(r.id)},${push(projectKey)},${push(generation)},${push(r.filePath)},${push(r.content)},` +
            `${push(r.description)},${push(r.startLine)},${push(r.endLine)},${push(r.language)},` +
            `${push(r.kind)},${push(r.role)},${push(r.quirkType)},${push(r.tags)},` +
            `${push(r.contentHash)},(${push(emb)})::vector,${push(r.syncHash??null)})`
        );
    });
    const sql =
        `INSERT INTO rag_chunks (id, project_key,generation_id, file_path, content, description, ` +
        `start_line, end_line, language, kind, role, quirk_type, tags, content_hash, embedding, sync_hash) ` +
        `VALUES ${tuples.join(', ')} ` +
        `ON CONFLICT (id,project_key,generation_id) DO UPDATE SET ` +
        `file_path = EXCLUDED.file_path, content = EXCLUDED.content, description = EXCLUDED.description, ` +
        `start_line = EXCLUDED.start_line, end_line = EXCLUDED.end_line, language = EXCLUDED.language, ` +
        `kind = EXCLUDED.kind, role = EXCLUDED.role, quirk_type = EXCLUDED.quirk_type, ` +
        `tags = EXCLUDED.tags, content_hash = EXCLUDED.content_hash, ` +
        `embedding = EXCLUDED.embedding, sync_hash = EXCLUDED.sync_hash, updated_at = now()`;
    return { sql, params };
}
