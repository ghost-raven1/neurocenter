import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TEXT_KNOWLEDGE_LIMITS, textBytes } from '../../../shared/project-text-knowledge.cjs';
import type { TextCorpusState, TextSource, TextKnowledgeLimits } from '../../../shared/project-text-knowledge.cjs';

export interface TextActor {
    email: string;
    activeRole: string;
}
export const textHash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const emptyTextHash = textHash('[]');

/** RAG accepts only the canonical project ID resolved by Catalog. */
export function textProject(value: unknown): string {
    if (typeof value !== 'string' || !/^prj-[a-zA-Z0-9-]{1,235}$/.test(value))
        throw new BadRequestException('Нужен ID проекта.');
    return value;
}
export function textActor(value: unknown): TextActor {
    const actor = value as Partial<TextActor> | null;
    if (
        !actor ||
        typeof actor.email !== 'string' ||
        !actor.email ||
        actor.email.length > 320 ||
        /[\x00-\x1f\x7f]/.test(actor.email) ||
        typeof actor.activeRole !== 'string' ||
        !actor.activeRole ||
        actor.activeRole.length > 128
    )
        throw new BadRequestException('Нужен автор текстовой операции.');
    return { email: actor.email, activeRole: actor.activeRole };
}
export function textRequestKey(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))
        throw new BadRequestException('Нужен ключ повтора.');
    return value;
}
export function textInput<T>(normalize: (value: unknown) => T, value: unknown): T {
    try {
        return normalize(value);
    } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : 'Некорректный текстовый запрос.');
    }
}

/** No state row is inserted merely to render an empty project. */
export function textState(projectId: string, row?: Record<string, unknown>): TextCorpusState {
    const updated = row?.updated_at;
    return {
        mode: 'text',
        projectId,
        revision: Number(row?.revision ?? 0),
        corpusHash: String(row?.corpus_hash ?? emptyTextHash),
        documentCount: Number(row?.document_count ?? 0),
        bytes: Number(row?.bytes ?? 0),
        updatedAt: updated ? (updated instanceof Date ? updated : new Date(String(updated))).toISOString() : null,
    };
}

/** Excerpts are literal substrings; line numbers follow LF, CRLF and CR from the uploaded file. */
export function textExcerpt(
    row: { id: string; path: string; content: string; score: number; query_lexemes?: string[] },
    limits: Readonly<TextKnowledgeLimits> = TEXT_KNOWLEDGE_LIMITS,
): TextSource {
    const lexemes = (row.query_lexemes ?? []).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const match = lexemes.length
        ? new RegExp('(^|[^\\p{L}\\p{N}_])(' + lexemes.join('|') + ')(?=$|[^\\p{L}\\p{N}_])', 'iu').exec(row.content)
        : null;
    const matched = match ? match.index + match[1].length : Math.max(0, row.content.search(/\S/u));
    let consumed = 0,
        startLine = 1;
    for (const match of row.content.matchAll(/\r\n|\r|\n/g)) {
        if (match.index! >= matched) break;
        consumed = match.index! + match[0].length;
        startLine++;
    }
    const prefix = row.content.slice(consumed, Math.max(consumed, matched));
    const start = consumed + (textBytes(prefix) > limits.excerptBytes / 2 ? prefix.length : 0);
    let excerpt = '',
        bytes = 0;
    for (const character of row.content.slice(start)) {
        const size = textBytes(character);
        if (bytes + size > limits.excerptBytes) break;
        excerpt += character;
        bytes += size;
    }
    // A final line delimiter belongs to the preceding line, not an empty line beyond the quote.
    const endLine = startLine + (excerpt.replace(/(?:\r\n|\r|\n)$/, '').match(/\r\n|\r|\n/g)?.length ?? 0);
    return { id: row.id, path: row.path, startLine, endLine, excerpt, score: Number(row.score) };
}
