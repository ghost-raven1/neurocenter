import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { IAccessActor } from '../access/access.model';
import { securityEvent } from '../access/security-events';
import { publicationHash } from '../publication/publication-validation';
import { createLearningContext } from '../../../shared/project-learning.cjs';
import type {
    ILearningCandidate,
    ILearningCandidateInput,
    ILearningCheck,
    ILearningCheckInput,
    ILearningContext,
    ILearningExperience,
    ILearningExperienceInput,
    ILearningHypothesisDraft,
    ILearningHypothesis,
    ILearningMutationInput,
    ILearningMutationResult,
    ILearningDeviceContext,
    ILearningModelProvenance,
    TLearningObservedExperienceInput,
    ILearningPage,
} from '../../../shared/project-learning.cjs';
import { authorizeLearning } from './learning-access';
import { rollbackLearningTransaction } from './learning-transaction';
import { candidateRow, checkRow, experienceRow, historyRow, hypothesisRow, type TLearningDbRow } from './learning-rows';
type TDb = Pick<PoolClient, 'query'>;
export type TLearningDeviceAuthorization = (db: PoolClient) => Promise<void>;
interface IMutationWork<T> {
    result: T;
    resourceId: string;
    details: Record<string, unknown>;
}
type TOrigin = { origin: 'human' | 'device' | 'llm'; device: ILearningDeviceContext | null };
interface ILearningCollections {
    experiences: ILearningExperience;
    hypotheses: ILearningHypothesis;
    candidates: ILearningCandidate;
}
const summaryHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Learning mutations are serialized per project and leave a durable exact-request receipt. */
export class LearningRepository {
    constructor(readonly pool: Pool) {}
    async revision(projectId: string, db: TDb = this.pool): Promise<number> {
        return Number(
            (
                await db.query<{ revision: string }>(
                    'SELECT revision FROM project_learning_state WHERE project_id=$1',
                    [projectId],
                )
            ).rows[0]?.revision ?? 0,
        );
    }
    async read<T>(
        actor: IAccessActor,
        projectId: string,
        work: (db: PoolClient) => Promise<T>,
        authorizeDevice?: TLearningDeviceAuthorization,
    ): Promise<T> {
        const db = await this.pool.connect();
        let discard = false;
        try {
            await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            await authorizeLearning(db, actor, projectId, 1);
            await authorizeDevice?.(db);
            const result = await work(db);
            await db.query('COMMIT');
            return result;
        } catch (error) {
            discard = await rollbackLearningTransaction(db);
            throw error;
        } finally {
            db.release(discard);
        }
    }
    async mutation<T>(
        actor: IAccessActor,
        projectId: string,
        input: { requestKey: string; expectedRevision?: number; hypothesisId?: string; id?: string },
        action: string,
        minimum: number,
        work: (db: PoolClient, revision: number) => Promise<IMutationWork<T>>,
        authorizeDevice?: TLearningDeviceAuthorization,
        append = false,
    ): Promise<ILearningMutationResult<T>> {
        const requestHash = publicationHash({ projectId, role: actor.activeRole, action, input }),
            db = await this.pool.connect();
        let discard = false;
        try {
            await db.query('BEGIN');
            await authorizeLearning(db, actor, projectId, minimum);
            await authorizeDevice?.(db);
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                'learning-request:' + actor.email + ':' + input.requestKey,
            ]);
            const old = (
                await db.query<{ request_hash: string; result: ILearningMutationResult<T> }>(
                    'SELECT request_hash,result FROM project_learning_requests WHERE actor=$1 AND request_key=$2',
                    [actor.email, input.requestKey],
                )
            ).rows[0];
            if (old) {
                if (old.request_hash !== requestHash)
                    throw new ConflictException('Ключ запроса уже относится к другому изменению обучения.');
                await db.query('COMMIT');
                return old.result;
            }
            await db.query('INSERT INTO project_learning_state(project_id) VALUES($1) ON CONFLICT DO NOTHING', [
                projectId,
            ]);
            const current = Number(
                (
                    await db.query<{ revision: string }>(
                        'SELECT revision FROM project_learning_state WHERE project_id=$1 FOR UPDATE',
                        [projectId],
                    )
                ).rows[0].revision,
            );
            if (!append && current !== input.expectedRevision)
                throw new ConflictException('Опыт проекта изменился. Обновите данные перед сохранением.');
            const next = current + 1;
            if (!Number.isSafeInteger(next))
                throw new ConflictException('Ревизия обучения вышла за допустимую границу.');
            await db.query('UPDATE project_learning_state SET revision=$2,updated_at=now() WHERE project_id=$1', [
                projectId,
                next,
            ]);
            const change = await work(db, next),
                result: ILearningMutationResult<T> = {
                    schemaVersion: 1,
                    projectId,
                    revision: next,
                    requestKey: input.requestKey,
                    result: change.result,
                };
            await db.query(
                'INSERT INTO project_learning_history(id,project_id,revision,action,resource_id,actor,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
                [randomUUID(), projectId, next, action, change.resourceId, actor.email, JSON.stringify(change.details)],
            );
            await securityEvent(db, {
                actor: actor.email,
                action: 'learning.' + action,
                resourceId: change.resourceId,
                before: { projectId, revision: current },
                after: { projectId, revision: next, ...change.details },
            });
            await db.query(
                'INSERT INTO project_learning_requests(actor,request_key,project_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)',
                [actor.email, input.requestKey, projectId, requestHash, JSON.stringify(result)],
            );
            await db.query('COMMIT');
            return result;
        } catch (error) {
            discard = await rollbackLearningTransaction(db);
            if ((error as { code?: string }).code === '23505')
                throw new ConflictException('Версия опыта уже существует. Обновите данные проекта.');
            throw error;
        } finally {
            db.release(discard);
        }
    }
    async experiences(db: TDb, projectId: string, ids?: string[]) {
        const rows = (
            await db.query<TLearningDbRow>(
                'SELECT * FROM project_learning_experiences WHERE project_id=$1' +
                    (ids ? ' AND id=ANY($2::uuid[])' : '') +
                    ' ORDER BY created_at DESC,id',
                ids ? [projectId, ids] : [projectId],
            )
        ).rows;
        if (ids && rows.length !== ids.length)
            throw new BadRequestException('Источник опыта отсутствует или относится к другому проекту.');
        return rows.map(experienceRow);
    }
    async hypotheses(db: TDb, projectId: string, id?: string) {
        const rows = (
            await db.query<TLearningDbRow>(
                'SELECT * FROM project_learning_hypotheses WHERE project_id=$1' +
                    (id ? ' AND id=$2' : '') +
                    ' ORDER BY created_at DESC,id',
                id ? [projectId, id] : [projectId],
            )
        ).rows;
        if (id && !rows.length) throw new NotFoundException('Гипотеза отсутствует в проекте.');
        return this.hypothesisRows(db, projectId, rows);
    }
    private async hypothesisRows(db: TDb, projectId: string, rows: TLearningDbRow[]) {
        if (!rows.length) return [];
        const checks = (
            await db.query<TLearningDbRow>(
                `SELECT * FROM (SELECT c.*,row_number() OVER(PARTITION BY hypothesis_id ORDER BY created_at DESC,id DESC) AS position,
            count(*) OVER(PARTITION BY hypothesis_id) AS total FROM project_learning_checks c WHERE project_id=$1 AND hypothesis_id=ANY($2::uuid[])) bounded WHERE position<=20 ORDER BY created_at,id`,
                [projectId, rows.map((row) => row.id)],
            )
        ).rows;
        return rows.map((row) => {
            const own = checks.filter((check) => check.hypothesis_id === row.id);
            return hypothesisRow(row, own.map(checkRow), Number(own[0]?.total ?? 0));
        });
    }
    private table(collection: 'experiences' | 'hypotheses' | 'candidates' | 'checks') {
        return 'project_learning_' + collection;
    }
    async page<C extends keyof ILearningCollections>(
        db: TDb,
        projectId: string,
        collection: C,
        before?: string,
    ): Promise<ILearningPage<ILearningCollections[C]>> {
        const table = this.table(collection),
            rows = await this.pageRows(db, projectId, table, before),
            ids = rows.items.map((row) => row.id);
        const items =
            collection === 'experiences'
                ? rows.items.map(experienceRow)
                : collection === 'hypotheses'
                  ? await this.hypothesisRows(db, projectId, rows.items)
                  : (await this.candidateRows(db, projectId, ids)).sort(
                        (a, b) => ids.indexOf(a.id) - ids.indexOf(b.id),
                    );
        return { ...rows, items } as ILearningPage<ILearningCollections[C]>;
    }
    async detail(db: TDb, projectId: string, collection: keyof ILearningCollections, id: string) {
        if (collection === 'hypotheses') return (await this.hypotheses(db, projectId, id))[0];
        if (collection === 'candidates') return (await this.candidates(db, projectId, id))[0];
        const row = (
            await db.query<TLearningDbRow>('SELECT * FROM project_learning_experiences WHERE project_id=$1 AND id=$2', [
                projectId,
                id,
            ])
        ).rows[0];
        if (!row) throw new NotFoundException('Опыт отсутствует в проекте.');
        return experienceRow(row);
    }
    private async pageRows(
        db: TDb,
        projectId: string,
        table: string,
        before?: string,
        hypothesisId?: string,
    ): Promise<ILearningPage<TLearningDbRow>> {
        const values: unknown[] = [projectId];
        let predicate = 'project_id=$1';
        if (hypothesisId) {
            values.push(hypothesisId);
            predicate += ' AND hypothesis_id=$' + values.length;
        }
        if (before) {
            const cursor = (
                await db.query<{ created_at: Date; id: string }>(
                    `SELECT created_at,id FROM ${table} WHERE ${predicate} AND id=$${values.length + 1}`,
                    [...values, before],
                )
            ).rows[0];
            if (!cursor) throw new NotFoundException('Курсор отсутствует в выбранном списке проекта.');
            values.push(before);
            predicate += ` AND (created_at,id)<(SELECT created_at,id FROM ${table} WHERE project_id=$1 AND id=$${values.length})`;
        }
        const items = (
            await db.query<TLearningDbRow>(
                `SELECT * FROM ${table} WHERE ${predicate} ORDER BY created_at DESC,id DESC LIMIT 101`,
                values,
            )
        ).rows;
        const total = Number(
            (
                await db.query<{ total: string }>(
                    `SELECT count(*) AS total FROM ${table} WHERE project_id=$1` +
                        (hypothesisId ? ' AND hypothesis_id=$2' : ''),
                    hypothesisId ? [projectId, hypothesisId] : [projectId],
                )
            ).rows[0].total,
        );
        const hasMore = items.length > 100;
        if (hasMore) items.pop();
        return { items, total, nextCursor: hasMore ? items[items.length - 1].id : null };
    }
    async checkPage(db: TDb, projectId: string, hypothesisId: string, before?: string) {
        const exists = (
            await db.query('SELECT 1 FROM project_learning_hypotheses WHERE project_id=$1 AND id=$2', [
                projectId,
                hypothesisId,
            ])
        ).rows.length;
        if (!exists) throw new NotFoundException('Гипотеза отсутствует в проекте.');
        const page = await this.pageRows(db, projectId, this.table('checks'), before, hypothesisId);
        return { ...page, items: page.items.map(checkRow) };
    }
    async checkDetail(db: TDb, projectId: string, hypothesisId: string, id: string) {
        const row = (
            await db.query<TLearningDbRow>(
                'SELECT * FROM project_learning_checks WHERE project_id=$1 AND hypothesis_id=$2 AND id=$3',
                [projectId, hypothesisId, id],
            )
        ).rows[0];
        if (!row) throw new NotFoundException('Проверка отсутствует у выбранной гипотезы проекта.');
        return checkRow(row);
    }
    private async candidateRows(db: TDb, projectId: string, ids?: string[], active = false) {
        if (ids && !ids.length) return [];
        if (active)
            return (
                await db.query<TLearningDbRow>(
                    `SELECT c.*,true AS active FROM project_learning_heads h JOIN project_learning_candidates c
            ON c.project_id=h.project_id AND c.id=h.candidate_id WHERE h.project_id=$1 ORDER BY h.key LIMIT 33`,
                    [projectId],
                )
            ).rows.map(candidateRow);
        const rows = (
            await db.query<TLearningDbRow>(
                `SELECT c.*,EXISTS(SELECT 1 FROM project_learning_heads h WHERE h.project_id=c.project_id AND h.candidate_id=c.id) AS active
            FROM project_learning_candidates c WHERE c.project_id=$1` +
                    (ids ? ' AND c.id=ANY($2::uuid[])' : '') +
                    ' ORDER BY c.created_at DESC,c.id DESC',
                ids ? [projectId, ids] : [projectId],
            )
        ).rows;
        return rows.map(candidateRow);
    }
    async candidates(db: TDb, projectId: string, id?: string): Promise<ILearningCandidate[]> {
        const rows = await this.candidateRows(db, projectId, id ? [id] : undefined);
        if (id && !rows.length) throw new NotFoundException('Кандидат отсутствует в проекте.');
        return rows;
    }
    async activeCandidates(db: TDb, projectId: string) {
        return this.candidateRows(db, projectId, undefined, true);
    }
    async history(db: TDb, projectId: string, beforeRevision?: number) {
        return (
            await db.query(
                'SELECT * FROM project_learning_history WHERE project_id=$1' +
                    (beforeRevision !== undefined ? ' AND revision<$2' : '') +
                    ' ORDER BY revision DESC,id LIMIT 100',
                beforeRevision !== undefined ? [projectId, beforeRevision] : [projectId],
            )
        ).rows.map(historyRow);
    }
    async receipt(db: TDb, actor: IAccessActor, projectId: string, key: string) {
        return (
            (
                await db.query<{ result: ILearningMutationResult }>(
                    'SELECT result FROM project_learning_requests WHERE actor=$1 AND project_id=$2 AND request_key=$3',
                    [actor.email, projectId, key],
                )
            ).rows[0]?.result ?? null
        );
    }
    async context(db: TDb, projectId: string): Promise<ILearningContext> {
        const active = await this.activeCandidates(db, projectId);
        if (active.some((candidate) => candidate.status !== 'approved' || !candidate.approvedAt))
            throw new ConflictException('Активный контекст не имеет действующего одобрения.');
        return createLearningContext({
            projectId,
            revision: await this.revision(projectId, db),
            entries: active.map((candidate) => ({
                id: candidate.id,
                key: candidate.key,
                version: candidate.version,
                kind: candidate.kind,
                title: candidate.title,
                content: candidate.content,
                targetAgentId: candidate.targetAgentId,
                hypothesisId: candidate.hypothesisId,
                checkId: candidate.checkId,
                approvedAt: candidate.approvedAt!,
            })),
        });
    }
    async addExperience(
        actor: IAccessActor,
        projectId: string,
        input: ILearningExperienceInput | TLearningObservedExperienceInput,
        source: TOrigin,
        authorizeDevice?: TLearningDeviceAuthorization,
        append = false,
    ) {
        return this.mutation(
            actor,
            projectId,
            { ...input, ...source },
            append ? 'experience.observe' : 'experience.record',
            2,
            async (db) => {
                const { requestKey: _key, ...rest } = input,
                    { expectedRevision: _rev, ...data } = rest as Omit<ILearningExperienceInput, 'requestKey'>,
                    id = randomUUID();
                await this.checkAgentContext(
                    db,
                    projectId,
                    input.context?.agentId,
                    input.context?.agentVersion,
                    input.context?.agentsRevision,
                );
                await db.query(
                    'INSERT INTO project_learning_experiences(id,project_id,data,created_by) VALUES($1,$2,$3::jsonb,$4)',
                    [id, projectId, JSON.stringify({ ...data, ...source }), actor.email],
                );
                const experience = (await this.experiences(db, projectId, [id]))[0];
                return {
                    result: { experience },
                    resourceId: id,
                    details: {
                        origin: source.origin,
                        outcome: input.outcome,
                        evidenceCount: input.evidence.length,
                        summarySha256: summaryHash(input.summary),
                    },
                };
            },
            authorizeDevice,
            append,
        );
    }
    async addHypotheses(
        actor: IAccessActor,
        projectId: string,
        input: ILearningMutationInput & { hypotheses: ILearningHypothesisDraft[]; model?: ILearningModelProvenance },
        source: TOrigin,
        authorizeDevice?: TLearningDeviceAuthorization,
        append = false,
    ) {
        return this.mutation(
            actor,
            projectId,
            { ...input, ...source },
            'hypothesis.propose',
            2,
            async (db, revision) => {
                const hypotheses: ILearningHypothesis[] = [];
                for (const draft of input.hypotheses) {
                    await this.experiences(db, projectId, draft.experienceIds);
                    const id = randomUUID();
                    await db.query(
                        'INSERT INTO project_learning_hypotheses(id,project_id,data,model,revision,created_by) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)',
                        [
                            id,
                            projectId,
                            JSON.stringify({ ...draft, ...source }),
                            input.model ? JSON.stringify(input.model) : null,
                            revision,
                            actor.email,
                        ],
                    );
                    hypotheses.push((await this.hypotheses(db, projectId, id))[0]);
                }
                return {
                    result: { hypotheses, hypothesis: hypotheses.length === 1 ? hypotheses[0] : null },
                    resourceId: hypotheses[0].id,
                    details: {
                        origin: source.origin,
                        count: hypotheses.length,
                        modelId: input.model?.modelId ?? null,
                        modelPin: input.model?.modelPin ?? null,
                    },
                };
            },
            authorizeDevice,
            append,
        );
    }
    async addCheck(actor: IAccessActor, projectId: string, hypothesisId: string, input: ILearningCheckInput) {
        return this.mutation(
            actor,
            projectId,
            { ...input, hypothesisId },
            'hypothesis.check',
            2,
            async (db, revision) => {
                const hypothesis = (await this.hypotheses(db, projectId, hypothesisId))[0];
                await this.experiences(db, projectId, input.experienceIds);
                const { requestKey: _key, expectedRevision: _rev, ...data } = input,
                    id = randomUUID();
                const checked = (
                    await db.query<TLearningDbRow>(
                        'INSERT INTO project_learning_checks(id,project_id,hypothesis_id,data,revision,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING *',
                        [id, projectId, hypothesisId, JSON.stringify(data), revision, actor.email],
                    )
                ).rows[0];
                if (input.method === 'human_review') {
                    const status =
                        input.result === 'passed'
                            ? 'supported'
                            : input.result === 'failed'
                              ? 'refuted'
                              : 'inconclusive';
                    await db.query(
                        'UPDATE project_learning_hypotheses SET status=$3,revision=$4 WHERE project_id=$1 AND id=$2',
                        [projectId, hypothesisId, status, revision],
                    );
                    // New evidence never silently leaves contradicted instructions in the active bundle.
                    if (input.result !== 'passed')
                        await db.query(
                            `DELETE FROM project_learning_heads h USING project_learning_candidates c WHERE h.project_id=$1 AND c.project_id=h.project_id
                    AND h.candidate_id=c.id AND c.hypothesis_id=$2`,
                            [projectId, hypothesisId],
                        );
                }
                return {
                    result: {
                        check: checkRow(checked),
                        hypothesis: (await this.hypotheses(db, projectId, hypothesisId))[0],
                    },
                    resourceId: id,
                    details: {
                        hypothesisId,
                        method: input.method,
                        result: input.result,
                        previousStatus: hypothesis.status,
                        summarySha256: summaryHash(input.summary),
                    },
                };
            },
        );
    }
    private async supportingCheck(
        db: TDb,
        projectId: string,
        hypothesisId: string,
        checkId: string,
    ): Promise<ILearningCheck> {
        const hypothesis = (await this.hypotheses(db, projectId, hypothesisId))[0];
        const latestRow = (
            await db.query<TLearningDbRow>(
                "SELECT * FROM project_learning_checks WHERE project_id=$1 AND hypothesis_id=$2 AND data->>'method'='human_review' ORDER BY revision DESC LIMIT 1",
                [projectId, hypothesisId],
            )
        ).rows[0];
        const proofRow = (
            await db.query<TLearningDbRow>(
                'SELECT * FROM project_learning_checks WHERE project_id=$1 AND hypothesis_id=$2 AND id=$3',
                [projectId, hypothesisId, checkId],
            )
        ).rows[0];
        const latest = latestRow ? checkRow(latestRow) : undefined,
            proof = proofRow ? checkRow(proofRow) : undefined;
        if (
            hypothesis.status !== 'supported' ||
            !latest ||
            latest.result !== 'passed' ||
            !proof ||
            proof.method !== 'human_review' ||
            proof.result !== 'passed'
        )
            throw new ConflictException(
                'Кандидат требует успешную проверку человеком с доказательствами и отсутствие последующего опровержения. Оценка LLM её не заменяет.',
            );
        await this.experiences(db, projectId, proof.experienceIds);
        return proof;
    }
    async addCandidate(actor: IAccessActor, projectId: string, input: ILearningCandidateInput) {
        return this.mutation(actor, projectId, input, 'candidate.propose', 2, async (db, revision) => {
            await this.supportingCheck(db, projectId, input.hypothesisId, input.checkId);
            await this.checkAgentContext(db, projectId, input.targetAgentId);
            const id = randomUUID(),
                version = Number(
                    (
                        await db.query<{ version: number }>(
                            'SELECT coalesce(max(version),0)+1 AS version FROM project_learning_candidates WHERE project_id=$1 AND key=$2',
                            [projectId, input.key],
                        )
                    ).rows[0].version,
                );
            const data = {
                kind: input.kind,
                title: input.title,
                content: input.content,
                ...(input.targetAgentId ? { targetAgentId: input.targetAgentId } : {}),
            };
            await db.query(
                'INSERT INTO project_learning_candidates(id,project_id,hypothesis_id,check_id,key,version,data,revision,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
                [
                    id,
                    projectId,
                    input.hypothesisId,
                    input.checkId,
                    input.key,
                    version,
                    JSON.stringify(data),
                    revision,
                    actor.email,
                ],
            );
            return {
                result: { candidate: (await this.candidates(db, projectId, id))[0] },
                resourceId: id,
                details: {
                    key: input.key,
                    version,
                    kind: input.kind,
                    hypothesisId: input.hypothesisId,
                    checkId: input.checkId,
                    contentSha256: summaryHash(input.content),
                },
            };
        });
    }
    async candidateAction(
        actor: IAccessActor,
        projectId: string,
        id: string,
        input: ILearningMutationInput & { reason?: string },
        action: 'approve' | 'reject' | 'revoke' | 'activate',
    ) {
        return this.mutation(actor, projectId, { ...input, id }, 'candidate.' + action, 3, async (db, revision) => {
            const candidate = (await this.candidates(db, projectId, id))[0];
            if (action === 'approve' || action === 'activate') {
                if (action === 'approve' ? candidate.status !== 'proposed' : candidate.status !== 'approved')
                    throw new ConflictException('Состояние кандидата не допускает это применение.');
                await this.supportingCheck(db, projectId, candidate.hypothesisId, candidate.checkId);
                await this.checkAgentContext(db, projectId, candidate.targetAgentId ?? undefined);
                if (action === 'approve')
                    await db.query(
                        "UPDATE project_learning_candidates SET status='approved',approved_by=$3,approved_at=clock_timestamp(),revision=$4,reason=$5 WHERE project_id=$1 AND id=$2",
                        [projectId, id, actor.email, revision, input.reason ?? null],
                    );
                await db.query(
                    'INSERT INTO project_learning_heads(project_id,key,candidate_id) VALUES($1,$2,$3) ON CONFLICT(project_id,key) DO UPDATE SET candidate_id=EXCLUDED.candidate_id',
                    [projectId, candidate.key, id],
                );
                try {
                    await this.context(db, projectId);
                } catch (error) {
                    if (error instanceof ConflictException) throw error;
                    throw new BadRequestException(
                        'Активный контекст допускает до 32 записей и 128 КиБ. Отзовите лишние записи перед применением.',
                    );
                }
            } else {
                if (action === 'reject' ? candidate.status !== 'proposed' : candidate.status !== 'approved')
                    throw new ConflictException('Состояние кандидата уже изменилось.');
                await db.query(
                    'UPDATE project_learning_candidates SET status=$3,revision=$4,reason=$5 WHERE project_id=$1 AND id=$2',
                    [projectId, id, action === 'reject' ? 'rejected' : 'revoked', revision, input.reason ?? null],
                );
                await db.query('DELETE FROM project_learning_heads WHERE project_id=$1 AND candidate_id=$2', [
                    projectId,
                    id,
                ]);
            }
            return {
                result: {
                    candidate: (await this.candidates(db, projectId, id))[0],
                    context: await this.context(db, projectId),
                },
                resourceId: id,
                details: {
                    key: candidate.key,
                    version: candidate.version,
                    action,
                    previousStatus: candidate.status,
                    contentSha256: summaryHash(candidate.content),
                },
            };
        });
    }
    private async checkAgentContext(
        db: TDb,
        projectId: string,
        agentId?: string,
        version?: number,
        agentsRevision?: number,
    ): Promise<void> {
        if (agentId) {
            const row = (
                await db.query<{ version: number }>(
                    'SELECT version FROM project_agents WHERE project_id=$1 AND agent_id=$2 AND NOT removed',
                    [projectId, agentId],
                )
            ).rows[0];
            if (!row || (version !== undefined && Number(row.version) !== version))
                throw new ConflictException('Источник опыта относится к другой версии или неназначенному агенту.');
        }
        if (agentsRevision !== undefined) {
            const current = Number(
                (
                    await db.query<{ revision: number }>(
                        'SELECT revision FROM project_agent_sets WHERE project_id=$1',
                        [projectId],
                    )
                ).rows[0]?.revision ?? 0,
            );
            if (current !== agentsRevision) throw new ConflictException('Ревизия агентов изменилась до записи опыта.');
        }
    }
}
