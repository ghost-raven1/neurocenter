import type {
    LearningExperience,
    LearningHypothesis,
    LearningCheck,
    LearningCandidate,
    LearningHistoryEntry,
    LearningDeviceContext,
    LearningModelProvenance,
} from '../../../shared/project-learning.cjs';
import {
    normalizeLearningExperienceInput,
    normalizeLearningHypothesisDraft,
    normalizeLearningCheckInput,
    normalizeLearningCandidateInput,
} from '../../../shared/project-learning.cjs';
export type LearningDbRow = {
    id: string;
    project_id: string;
    data: Record<string, unknown>;
    created_by: string;
    created_at: Date | string;
    revision?: string | number;
    [key: string]: unknown;
};
const timestamp = (value: Date | string) => new Date(value).toISOString();
const base = (row: LearningDbRow) => ({
    id: row.id,
    projectId: row.project_id,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
});
const emptyRequest = { requestKey: '00000000-0000-4000-8000-000000000000', expectedRevision: 0 };
export function experienceRow(row: LearningDbRow): LearningExperience {
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
        origin: origin as LearningExperience['origin'],
        device: device as LearningDeviceContext | null,
    };
}
export function checkRow(row: LearningDbRow): LearningCheck {
    const {
        requestKey: _key,
        expectedRevision: _rev,
        ...input
    } = normalizeLearningCheckInput({ ...row.data, ...emptyRequest });
    return { ...base(row), ...input, hypothesisId: String(row.hypothesis_id), revision: Number(row.revision) };
}
export function hypothesisRow(
    row: LearningDbRow,
    checks: LearningCheck[],
    checkCount = checks.length,
): LearningHypothesis {
    const { origin, device, ...draft } = row.data;
    return {
        ...base(row),
        ...normalizeLearningHypothesisDraft(draft),
        origin: origin as LearningHypothesis['origin'],
        device: device as LearningDeviceContext | null,
        model: row.model as LearningModelProvenance | null,
        status: row.status as LearningHypothesis['status'],
        revision: Number(row.revision),
        checks,
        checkCount,
        checksNextCursor: checkCount > checks.length ? (checks[0]?.id ?? null) : null,
    };
}
export function candidateRow(row: LearningDbRow): LearningCandidate {
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
        status: row.status as LearningCandidate['status'],
        active: row.active === true,
        revision: Number(row.revision),
        approvedBy: row.approved_by as string | null,
        approvedAt: row.approved_at ? timestamp(row.approved_at as Date | string) : null,
        reason: row.reason as string | null,
    };
}
export function historyRow(row: Record<string, unknown>): LearningHistoryEntry {
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
