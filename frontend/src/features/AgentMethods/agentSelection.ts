import type {AgentMethodWorkflowAgentIdentity} from '../../../../services/shared/agent-method-workflow.cjs';
import type {IAgentCatalog,IProjectAgent} from '../AgentCatalog/types';

export type WorkflowAgentCatalog=Pick<IAgentCatalog,'items'|'assignments'|'revision'>;

/** Eligibility explains the next action without substituting another project agent. */
export function workflowAgentIssue(assignment:IProjectAgent|undefined,catalog:WorkflowAgentCatalog|null):string{
    if(!assignment||assignment.removed||assignment.card.archivedAt)return 'Выбранный агент больше не доступен в проекте. Обновите список и выберите исполнителя.';
    const head=catalog?.items.find(item=>item.id===assignment.agentId);
    if(!head)return 'Текущий статус агента не подтверждён. Обновите список агентов проекта.';
    if(head.archivedAt)return 'Выбранный агент больше не доступен в проекте. Обновите список и выберите исполнителя.';
    if(!assignment.enabled)return 'Включите выбранного агента в проекте или выберите другого исполнителя.';
    if(!['primary','all'].includes(assignment.effective.mode))return 'Полный цикл выполняет основной агент. Измените режим выбранного агента или выберите другого.';
    if(!assignment.effective.model?.trim())return 'Задайте явную модель выбранного агента в настройках проекта.';
    return '';
}

/** Current names are decorative; pinned slug/version remain visible when the project has moved on. */
export function workflowAgentLabel(identity:AgentMethodWorkflowAgentIdentity,catalog?:WorkflowAgentCatalog|null):string{
    const current=catalog?.revision===identity.agentsRevision?catalog.assignments.find(item=>item.agentId===identity.agentId
        &&item.card.slug===identity.slug&&item.version===identity.version):undefined;
    return `${current?current.card.name+' · ':''}${identity.slug} · v${identity.version}`;
}
