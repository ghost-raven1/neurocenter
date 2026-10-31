import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { ModelsService } from '../models/models.service';
import { ProjectRagClient } from '../models/project-rag-client';
import { authorizeRagIntentAuthor } from '../models/project-rag-authorization';
import { RAG_WRITE_POLICY } from '../../../shared/rag-write-authorization.cjs';
import { requireFeatureEnabled } from '../features/require-feature-enabled';
import { RuntimeLimitsService } from '../runtime-limits/runtime-limits.service';
import {
    normalizeTextUpload,
    normalizeTextSearch,
    normalizeTextContext,
    textUploadCanonical,
    TEXT_KNOWLEDGE_CEILINGS,
    textKnowledgeLimits,
    textKnowledgeAdmission,
    textBytes,
    type TextCorpusState,
    type TextUploadReceipt,
    type TextSearchResult,
    type TextContext,
    type TextAdmission,
} from '../../../shared/project-text-knowledge.cjs';

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
export const textRequestHash = (value: unknown) =>
    createHash('sha256').update(textUploadCanonical(value)).digest('hex');
export function requireTextState(value: unknown, projectId: string): TextCorpusState {
    if (
        !object(value) ||
        value.mode !== 'text' ||
        value.projectId !== projectId ||
        !integer(value.revision) ||
        !sha(value.corpusHash) ||
        !integer(value.documentCount) ||
        !integer(value.bytes) ||
        !(
            value.updatedAt === null ||
            (typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)))
        )
    ) {
        throw new ServiceUnavailableException(
            'Состояние текстовой базы знаний не подтверждено. Повторите загрузку сведений.',
        );
    }
    return value as unknown as TextCorpusState;
}
export function requireTextResult(value: unknown, projectId: string): TextSearchResult {
    if (
        !object(value) ||
        value.mode !== 'text' ||
        value.projectId !== projectId ||
        !integer(value.revision) ||
        !sha(value.corpusHash) ||
        !Array.isArray(value.sources) ||
        value.sources.length > TEXT_KNOWLEDGE_CEILINGS.sources
    )
        throw new ServiceUnavailableException('Результаты текстового поиска не подтверждены.');
    const ids = new Set<string>();
    let admission: TextAdmission | undefined;
    if (value.admission !== undefined) {
        try {
            admission = textKnowledgeAdmission(value.admission);
        } catch {
            throw new ServiceUnavailableException('Снимок лимитов поиска не подтверждён.');
        }
    }
    if (admission && value.sources.length > admission.limits.sources)
        throw new ServiceUnavailableException('Выдача превышает принятый лимит источников.');
    for (const source of value.sources) {
        if (
            !object(source) ||
            typeof source.id !== 'string' ||
            !source.id ||
            ids.has(source.id) ||
            typeof source.path !== 'string' ||
            !source.path ||
            textBytes(source.path) > TEXT_KNOWLEDGE_CEILINGS.pathBytes ||
            typeof source.excerpt !== 'string' ||
            !source.excerpt.trim() ||
            textBytes(source.excerpt) > TEXT_KNOWLEDGE_CEILINGS.excerptBytes ||
            !integer(source.startLine) ||
            source.startLine < 1 ||
            !integer(source.endLine) ||
            source.endLine < source.startLine ||
            typeof source.score !== 'number' ||
            !Number.isFinite(source.score) ||
            source.score < 0 ||
            source.score > 1
        )
            throw new ServiceUnavailableException('Сервис знаний вернул неподтверждённую цитату.');
        if (admission && textBytes(source.excerpt) > admission.limits.excerptBytes)
            throw new ServiceUnavailableException('Цитата превышает принятые лимиты.');
        ids.add(source.id);
    }
    return value as unknown as TextSearchResult;
}

/** Catalog owns fresh project authority; text bytes and committed receipts belong to RAG. */
@Injectable()
export class ProjectTextKnowledge {
    readonly client = new ProjectRagClient();
    constructor(private readonly models: ModelsService) {}
    async state(req: Request, id: string): Promise<TextCorpusState> {
        const project = await this.models.resolveProject(req, id, 1);
        const result = requireTextState(await this.client.call('text/state', { projectId: project.id }), project.id);
        await this.models.resolveProject(req, project.id, 1);
        return result;
    }
    async receipt(req: Request, id: string, key: string): Promise<TextUploadReceipt | null> {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(key))
            throw new BadRequestException('Некорректный ключ загрузки.');
        const actor = await this.models.actor(req),
            project = await this.models.resolveProject(req, id, 1, actor);
        const result = await this.client.call<TextUploadReceipt | null>('text/receipt', {
            projectId: project.id,
            requestKey: key,
            actor: { email: actor.email, activeRole: actor.activeRole },
        });
        await this.models.resolveProject(req, project.id, 1);
        if (result !== null) {
            requireTextState(result, project.id);
            if (result.requestKey !== key || !sha(result.requestHash) || typeof result.acceptedAt !== 'string')
                throw new ServiceUnavailableException('Квитанция загрузки не подтверждена.');
            if (result.admission !== undefined) {
                try {
                    textKnowledgeAdmission(result.admission);
                } catch {
                    throw new ServiceUnavailableException('Снимок лимитов квитанции не подтверждён.');
                }
            }
        }
        return result;
    }
    async upload(req: Request, id: string, raw: unknown): Promise<TextUploadReceipt> {
        let input;
        try {
            input = normalizeTextUpload(raw, TEXT_KNOWLEDGE_CEILINGS);
        } catch (error) {
            throw new BadRequestException((error as Error).message);
        }
        const actor = await this.models.actor(req),
            project = await this.models.resolveProject(req, id, 1, actor),
            requestHash = textRequestHash(input);
        const prior = await this.receipt(req, project.id, input.requestKey);
        if (prior) {
            if (prior.requestHash !== requestHash)
                throw new ConflictException('Ключ повтора уже относится к другим файлам или ревизии.');
            return prior;
        }
        await requireFeatureEnabled('project_text_knowledge');
        await this.models.resolveProject(req, project.id, 2);
        const value = await this.client.call<TextUploadReceipt>('text/upload', {
            projectId: project.id,
            input,
            requestHash,
            actor: { email: actor.email, activeRole: actor.activeRole },
        });
        requireTextState(value, project.id);
        if (
            value.requestKey !== input.requestKey ||
            value.requestHash !== requestHash ||
            typeof value.acceptedAt !== 'string'
        )
            throw new ServiceUnavailableException(
                'Запись могла завершиться. Проверьте квитанцию с прежним ключом перед повтором.',
            );
        await this.models.resolveProject(req, project.id, 1);
        return value;
    }
    async search(
        req: Request,
        id: string,
        raw: unknown,
        signal?: AbortSignal,
        admission?: TextAdmission,
    ): Promise<TextSearchResult> {
        let input;
        try {
            input = normalizeTextSearch(raw, TEXT_KNOWLEDGE_CEILINGS);
        } catch (error) {
            throw new BadRequestException((error as Error).message);
        }
        const project = await this.models.resolveProject(req, id, 1);
        await requireFeatureEnabled('project_text_knowledge');
        const found = requireTextResult(
            await this.client.call(
                'text/search',
                { projectId: project.id, input, ...(admission ? { admission } : {}) },
                signal,
            ),
            project.id,
        );
        await this.models.resolveProject(req, project.id, 1);
        if (input.revision !== undefined && found.revision !== input.revision)
            throw new ConflictException('Текстовая база изменилась. Обновите поиск.');
        return found;
    }
    async assertContext(req: Request, id: string, raw: unknown): Promise<TextContext> {
        let selection;
        try {
            selection = normalizeTextContext(raw, TEXT_KNOWLEDGE_CEILINGS);
        } catch (error) {
            throw new BadRequestException((error as Error).message);
        }
        const state = await this.state(req, id);
        if (state.revision !== selection.revision || state.corpusHash !== selection.corpusHash)
            throw new ConflictException(
                'Текстовая база изменилась после выбора. Повторите поиск и подтвердите новый контекст.',
            );
        return selection;
    }
    /** Called by the authenticated RAG owner immediately before its first SQL mutation. */
    async authorize(value: unknown): Promise<{ ok: true }> {
        if (
            !object(value) ||
            !['actor', 'projectId', 'requestHash', 'requestKey'].every((key) =>
                Object.prototype.hasOwnProperty.call(value, key),
            ) ||
            Object.keys(value).some(
                (key) => !['actor', 'projectId', 'requestHash', 'requestKey', 'admission'].includes(key),
            ) ||
            typeof value.projectId !== 'string' ||
            !/^prj-[a-zA-Z0-9-]{1,235}$/.test(value.projectId) ||
            !sha(value.requestHash) ||
            typeof value.requestKey !== 'string' ||
            !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.requestKey) ||
            !object(value.actor) ||
            Object.keys(value.actor).sort().join(',') !== 'activeRole,email' ||
            typeof value.actor.email !== 'string' ||
            typeof value.actor.activeRole !== 'string'
        )
            throw new BadRequestException('Нужен подтверждённый автор текстовой записи.');
        const db = await this.models.pool.connect();
        let discard = false;
        try {
            await db.query('BEGIN');
            await db.query("SET LOCAL lock_timeout='3s'");
            await db.query("SET LOCAL statement_timeout='7s'");
            if (!(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [value.projectId])).rowCount)
                throw new NotFoundException('Проект недоступен.');
            await authorizeRagIntentAuthor(db, value.projectId, {
                author_email: value.actor.email,
                author_role: value.actor.activeRole,
                write_policy: RAG_WRITE_POLICY,
            });
            await requireFeatureEnabled('project_text_knowledge');
            if (value.admission !== undefined) {
                const admission = value.admission;
                if (
                    !object(admission) ||
                    Object.keys(admission).sort().join(',') !== 'limits,revision' ||
                    !integer(admission.revision)
                )
                    throw new BadRequestException('Нужен снимок лимитов загрузки.');
                let limits;
                try {
                    limits = textKnowledgeLimits(admission.limits);
                } catch {
                    throw new BadRequestException('Снимок лимитов не подтверждён.');
                }
                const current = await new RuntimeLimitsService(this.models).effective(db);
                if (
                    current.revision !== admission.revision ||
                    JSON.stringify(current.policy.textKnowledge) !== JSON.stringify(limits)
                )
                    throw new ConflictException(
                        'Лимиты изменились во время подготовки. Обновите сведения перед новой записью.',
                    );
            }
            await db.query('COMMIT');
            return { ok: true };
        } catch (error) {
            await db.query('ROLLBACK').catch(() => {
                discard = true;
            });
            throw error;
        } finally {
            db.release(discard);
        }
    }
}
