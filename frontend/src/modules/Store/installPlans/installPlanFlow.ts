import type { IInstallPlan, IInstallPlanInput } from '../../../features/McpBridge/api';

export interface IPlanFlowApi {
    preparePlan(input: IInstallPlanInput): Promise<IInstallPlan>;
    approvePlan(plan: IInstallPlan): Promise<IInstallPlan>;
}
export interface IPlanExecution {
    api: IPlanFlowApi;
    current(): boolean;
    prepareCatalog?(): Promise<boolean>;
    enqueue(plan: IInstallPlan): Promise<void>;
}

/** Несовпадение области или манифеста останавливает установку до отправки задания. */
function assertPlan(plan: IInstallPlan, expected: IInstallPlanInput): void {
    if (!plan || !plan.id || plan.projectId !== expected.projectId || plan.assetId !== expected.assetId
        || plan.assetKind !== expected.assetKind || plan.version !== expected.version
        || !/^[a-f0-9]{64}$/.test(plan.manifest) || !Number.isSafeInteger(plan.revision) || plan.revision < 0
        || !['pending', 'approved', 'revoked'].includes(plan.status)) {
        throw new Error('План установки изменился. Откройте инструмент заново.');
    }
}

/** Одобренный пакет отправляется сразу; остальные возвращаются для явного просмотра. */
export async function prepareInstallation(input: IInstallPlanInput, execution: IPlanExecution, reviewOnly = false): Promise<IInstallPlan | undefined> {
    if (!reviewOnly && execution.prepareCatalog && !await execution.prepareCatalog()) { return; }
    if (!execution.current()) { return; }
    const plan = await execution.api.preparePlan(input);
    if (!execution.current()) { return; }
    assertPlan(plan, input);
    if (plan.status === 'approved' && !reviewOnly) { await execution.enqueue(plan); return; }
    return plan;
}

/** Запоздалое одобрение после отмены или смены профиля не запускает установку. */
export async function approveInstallation(plan: IInstallPlan, execution: IPlanExecution): Promise<void> {
    const approved = await execution.api.approvePlan(plan);
    if (!execution.current()) { return; }
    assertPlan(approved, plan);
    if (approved.id !== plan.id || approved.manifest !== plan.manifest || approved.status !== 'approved'
        || approved.revision <= plan.revision) {
        throw new Error('Одобрение относится к другому состоянию плана. Откройте инструмент заново.');
    }
    await execution.enqueue(approved);
}

/** Отзыв должен подтвердить ту же версию и следующий номер состояния. */
export async function revokeInstallationPlan(plan: IInstallPlan, revoke: (plan: IInstallPlan) => Promise<IInstallPlan>, current: () => boolean): Promise<IInstallPlan | undefined> {
    const revoked = await revoke(plan);
    if (!current()) { return; }
    assertPlan(revoked, plan);
    if (revoked.id !== plan.id || revoked.manifest !== plan.manifest || revoked.status !== 'revoked' || revoked.revision <= plan.revision) {
        throw new Error('Состояние разрешения изменилось. Откройте инструмент заново.');
    }
    return revoked;
}

/** Перечитывает тот же план; событие не готовит новый пакет и не запускает установку. */
export async function refreshInstallationPlan(plan: IInstallPlan, read: (id: string) => Promise<IInstallPlan>, current: () => boolean): Promise<IInstallPlan | undefined> {
    const next = await read(plan.id);
    if (!current()) { return; }
    assertPlan(next, plan);
    if (next.id !== plan.id || next.manifest !== plan.manifest) {
        throw new Error('Ответ относится к другому плану установки. Откройте инструмент заново.');
    }
    if (next.revision < plan.revision || next.revision === plan.revision && next.status !== plan.status) { return; }
    return next;
}
