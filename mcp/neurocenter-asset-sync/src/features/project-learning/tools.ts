import { z } from 'zod';
import { api } from '../../bridge/state.js';
import {
    readRagProjectIdentity,
    verifiedRagProjectIdentity,
    type IRagProjectIdentity,
} from '../../lib/rag-project-identity.js';
import {
    normalizeLearningContext,
    normalizeLearningExperienceInput,
    normalizeLearningHypothesisInput,
    type LearningContext,
    type LearningMutationResult,
} from './contract.js';

const project = z.string().min(1).max(4096).optional();
const mutation = { requestKey: z.string().uuid(), expectedRevision: z.number().int().nonnegative() };
const sourceContext = z
    .object({
        agentId: z.string().min(1).max(200).optional(),
        agentVersion: z.number().int().positive().optional(),
        agentsRevision: z.number().int().nonnegative().optional(),
        gitCommit: z
            .string()
            .regex(/^[a-f0-9]{40,64}$/)
            .optional(),
        sourceSnapshot: z.string().min(1).max(200).optional(),
    })
    .strict();
export const projectLearningContextSchema = z.object({ project }).strict();
export const projectLearningRecordSchema = z
    .object({
        project,
        ...mutation,
        title: z.string().min(1).max(256),
        summary: z.string().min(1).max(8192),
        outcome: z.enum(['succeeded', 'failed', 'mixed', 'unknown']),
        evidence: z
            .array(
                z
                    .object({
                        kind: z.enum(['test', 'typecheck', 'lint', 'lsp', 'human_feedback', 'artifact', 'observation']),
                        status: z.enum(['passed', 'failed', 'unknown']),
                        summary: z.string().min(1).max(4096),
                        reference: z.string().min(1).max(1024).optional(),
                        sha256: z
                            .string()
                            .regex(/^[a-f0-9]{64}$/)
                            .optional(),
                    })
                    .strict(),
            )
            .min(1)
            .max(32),
        context: sourceContext.optional(),
    })
    .strict();
export const projectLearningProposeSchema = z
    .object({
        project,
        ...mutation,
        subject: z.enum(['project', 'agent']),
        title: z.string().min(1).max(256),
        statement: z.string().min(1).max(8192),
        rationale: z.string().min(1).max(8192),
        verificationPlan: z.string().min(1).max(8192),
        experienceIds: z.array(z.string().uuid()).min(1).max(50),
    })
    .strict();
export type ProjectLearningContextInput = z.infer<typeof projectLearningContextSchema>;
export type ProjectLearningRecordInput = z.infer<typeof projectLearningRecordSchema>;
export type ProjectLearningProposeInput = z.infer<typeof projectLearningProposeSchema>;
export const REPORTED_LEARNING_NOTE =
    'Запись получена от MCP как сообщение об опыте, а не независимое подтверждение результата. Гипотезы не активны; новое знание принимает человек.';

const unavailable = () =>
    new Error('Проектное обучение требует подтверждённой локальной папки v2. Свяжите её на странице «Проекты».');
async function identity(
    input: ProjectLearningContextInput,
    cwd: string,
): Promise<IRagProjectIdentity & { projectKey: string; bindingId: string; instanceId: string }> {
    const initial = (await readRagProjectIdentity({ project: input.project }, cwd)).value;
    if (!initial.projectKey || !verifiedRagProjectIdentity(initial, initial.projectKey)) throw unavailable();
    return initial as IRagProjectIdentity & { projectKey: string; bindingId: string; instanceId: string };
}
async function current(input: ProjectLearningContextInput, cwd: string, expected: IRagProjectIdentity): Promise<void> {
    const checked = await identity(input, cwd);
    if (!verifiedRagProjectIdentity(checked, expected.projectKey!, expected)) throw unavailable();
}
const envelope = (value: { projectKey: string; bindingId: string; instanceId: string }) => ({
    projectId: value.projectKey,
    bindingId: value.bindingId,
    instanceId: value.instanceId,
});

/** Only the server's human-approved, project-scoped bundle is returned as working knowledge. */
export async function projectLearningContext(raw: ProjectLearningContextInput, cwd: string): Promise<LearningContext> {
    const input = projectLearningContextSchema.parse(raw),
        target = await identity(input, cwd);
    const response = await api<unknown>('learning/context', envelope(target));
    await current(input, cwd, target);
    const context = normalizeLearningContext(response);
    if (context.projectId !== target.projectKey) throw new Error('Контекст обучения относится к другому проекту.');
    return context;
}

function mutationResponse(
    value: unknown,
    projectId: string,
    requestKey: string,
    hypotheses = false,
): LearningMutationResult<unknown> {
    const item = z.record(z.unknown()),
        result = z
            .object({
                schemaVersion: z.literal(1),
                projectId: z.literal(projectId),
                revision: z.number().int().nonnegative(),
                requestKey: z.literal(requestKey),
                result: item,
            })
            .strict()
            .parse(value);
    const entries = hypotheses
        ? z.array(item).min(1).max(10).parse(result.result.hypotheses)
        : [item.parse(result.result.experience)];
    if (entries.some((entry) => entry.projectId !== projectId || entry.origin !== 'device'))
        throw new Error('Ответ обучения относится к другому проекту или источнику.');
    return result;
}

/** Reported observations cannot approve themselves, change prompts or grant tool permissions. */
export async function projectLearningRecord(raw: ProjectLearningRecordInput, cwd: string) {
    const { project: folder, ...body } = projectLearningRecordSchema.parse(raw),
        input = normalizeLearningExperienceInput(body),
        target = await identity({ project: folder }, cwd);
    await current({ project: folder }, cwd, target);
    const response = await api<unknown>('learning/record', { ...envelope(target), input });
    await current({ project: folder }, cwd, target);
    return { ...mutationResponse(response, target.projectKey, input.requestKey), note: REPORTED_LEARNING_NOTE };
}

/** A hypothesis is an unreviewed proposal linked to existing experience, never an active lesson. */
export async function projectLearningPropose(raw: ProjectLearningProposeInput, cwd: string) {
    const { project: folder, ...body } = projectLearningProposeSchema.parse(raw),
        input = normalizeLearningHypothesisInput(body),
        target = await identity({ project: folder }, cwd);
    await current({ project: folder }, cwd, target);
    const response = await api<unknown>('learning/propose', { ...envelope(target), input });
    await current({ project: folder }, cwd, target);
    return { ...mutationResponse(response, target.projectKey, input.requestKey, true), note: REPORTED_LEARNING_NOTE };
}
