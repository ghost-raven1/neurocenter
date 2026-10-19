import type { IRagSummary } from '../../../core/api/interfaces';

/** Серверная копия подтверждается полным snapshot; наличие строк не означает готовность локального поиска. */
export function ragSummaryState(summary: IRagSummary): { title: string; verified: boolean } {
    if (!summary.rowCount) { return {title:'Данных пока нет',verified:false}; }
    if (summary.incompleteRows && summary.incompleteRows > 0) { return {title:'Есть неполные данные',verified:false}; }
    if (summary.indexState === 'syncing') { return {title:'Передача не завершена',verified:false}; }
    const verified = summary.complete === true && summary.indexState === 'ready' && summary.fingerprintVersion === 1
        && summary.usableVectorCount === summary.rowCount && summary.incompleteRows === 0
        && !!summary.indexProfile?.provider && !!summary.indexProfile.model
        && summary.indexProfile.dimension === summary.dimension && /^[a-f0-9]{64}$/.test(summary.snapshotHash || '');
    return {title:verified ? 'Копия проверена' : 'Копия не проверена',verified};
}
