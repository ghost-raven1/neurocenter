import type { ILearningAnalysis, IAnalysisRow } from './learning-analysis.interfaces';
const date = (value: Date | string): string => new Date(value).toISOString();

/** Worker-only snapshots and actor identity never enter the browser job response. */
export function analysisView(row: IAnalysisRow): ILearningAnalysis {
    return {
        id: row.id,
        projectId: row.project_id,
        requestKey: row.request_key,
        state: row.state,
        modelId: row.model_id,
        modelPin: row.model_pin,
        experienceIds: row.input.experienceIds,
        sourceRevision: Number(row.source_revision),
        createdAt: date(row.created_at),
        updatedAt: date(row.updated_at),
        startedAt: row.started_at ? date(row.started_at) : null,
        finishedAt: row.finished_at ? date(row.finished_at) : null,
        hypothesisIds: row.hypothesis_ids,
        error: row.error_code ? { code: row.error_code, message: row.error_message || 'Анализ не завершён.' } : null,
    };
}
