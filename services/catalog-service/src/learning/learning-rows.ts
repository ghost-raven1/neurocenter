import type {
    ILearningExperience,
    ILearningHypothesis,
    ILearningCheck,
    ILearningCandidate,
    ILearningHistoryEntry,
    ILearningDeviceContext,
    ILearningModelProvenance,
} from '../../../shared/project-learning.cjs';
import {
    normalizeLearningExperienceInput,
    normalizeLearningHypothesisDraft,
    normalizeLearningCheckInput,
    normalizeLearningCandidateInput,
} from '../../../shared/project-learning.cjs';
export type TLearningDbRow = {
    id: string;
    project_id: string;
    data: Record<string, unknown>;
    created_by: string;
    created_at: Date | string;
    revision?: string | number;
    [key: string]: unknown;
};
const timestamp = (value: Date | string) => new Date(value).toISOString();
const base = (row: TLearningDbRow) => ({
    id: row.id,
    projectId: row.project_id,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
});
const emptyRequest = { requestKey: '00000000-0000-4000-8000-000000000000', expectedRevision: 0 };
export function experienceRow(row: TLearningDbRow): ILearningExperience {
    const { origin, device, ...data } = row.data;
    const {
        requestKey: _key,
        expectedRevision: _rev,
        ...input
    } = normalizeLearningExperienceInput({ ...data, ...emptyRequest });
    return {
        ...base(row),
        ...input,
        context: input.context ?? {},
        origin: origin as ILearningExperience['origin'],
        device: device as ILearningDeviceContext | null,
    };
}
export function checkRow(row: TLearningDbRow): ILearningCheck {
    const {
        requestKey: _key,
        expectedRevision: _rev,
        ...input
    } = normalizeLearningCheckInput({ ...row.data, ...emptyRequest });
    return { ...base(row), ...input, hypothesisId: String(row.hypothesis_id), revision: Number(row.revision) };
}
export function hypothesisRow(
    row: TLearningDbRow,
    checks: ILearningCheck[],
    checkCount = checks.length,
): ILearningHypothesis {
    const { origin, device, ...draft } = row.data;
    return {
        ...base(row),
        ...normalizeLearningHypothesisDraft(draft),
        origin: origin as ILearningHypothesis['origin'],
        device: device as ILearningDeviceContext | null,
        model: row.model as ILearningModelProvenance | null,
        status: row.status as ILearningHypothesis['status'],
        revision: Number(row.revision),
        checks,
        checkCount,
        checksNextCursor: checkCount > checks.length ? (checks[0]?.id ?? null) : null,
    };
}
export function candidateRow(row: TLearningDbRow): ILearningCandidate {
    const input = normalizeLearningCandidateInput({
        ...row.data,
        ...emptyRequest,
        hypothesisId: row.hypothesis_id,
        checkId: row.check_id,
        key: row.key,
    });
    return {
        ...base(row),
        hypothesisId: input.hypothesisId,
        checkId: input.checkId,
        key: input.key,
        version: Number(row.version),
        kind: input.kind,
        title: input.title,
        content: input.content,
        targetAgentId: input.targetAgentId ?? null,
        status: row.status as ILearningCandidate['status'],
        active: row.active === true,
        revision: Number(row.revision),
        approvedBy: row.approved_by as string | null,
        approvedAt: row.approved_at ? timestamp(row.approved_at as Date | string) : null,
        reason: row.reason as string | null,
    };
}
export function historyRow(row: Record<string, unknown>): ILearningHistoryEntry {
    return {
        id: String(row.id),
        projectId: String(row.project_id),
        revision: Number(row.revision),
        action: String(row.action),
        resourceId: String(row.resource_id),
        actor: String(row.actor),
        createdAt: timestamp(row.created_at as Date | string),
        details: row.details as Record<string, unknown>,
    };
}
