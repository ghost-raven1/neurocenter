import type {AgentToolCapabilities, AgentToolGrant, AgentToolsDraft} from './types';
export const emptyAgentToolsDraft = (): AgentToolsDraft => ({initialized: false,enabled: false,rag: false,systemRoles: false,publicChats: false,consent: false,modelTouched: false});
/** Only a fresh untouched draft receives available safe defaults; manual null and restored pins are exact. */
export function defaultAgentToolsDraft(draft: AgentToolsDraft, capabilities: AgentToolCapabilities): AgentToolsDraft {
    let next = draft;
    if (!draft.initialized && capabilities.available) next = {...draft,initialized: true,enabled: capabilities.rag.available || capabilities.systemRoles.available,rag: capabilities.rag.available,systemRoles: capabilities.systemRoles.available};
    const first = capabilities.publicChats.models[0];
    if (!next.modelTouched && !next.model && first) next = {...next,model: {id: first.id,pin: first.pin,name: first.name}};
    return next;
}
export function restoredAgentToolsDraft(grant?: AgentToolGrant): AgentToolsDraft {
    return {...emptyAgentToolsDraft(),initialized: true,enabled: !!grant,rag: grant?.rag ?? false,systemRoles: !!grant?.systemRoles,publicChats: !!grant?.publicChats,
        modelTouched: true,consent: !!grant?.publicChats, ...(grant ? {restored: structuredClone(grant)} : {}), ...(grant?.publicChats ? {model: {id: grant.publicChats.modelId,pin: grant.publicChats.expectedModelPin},...(grant.publicChats.roomId ? {roomId: grant.publicChats.roomId} : {})} : {})};
}
/** Building a grant never substitutes an updated model version or silently drops a selected source. */
export function agentToolsSelection(draft: AgentToolsDraft, capabilities?: AgentToolCapabilities): {request?: AgentToolGrant; reason?: string} {
    if (!draft.enabled) return {};
    if (!capabilities?.available) return {reason: capabilities?.reason || 'Проверяем доступность инструментов…'};
    if (draft.rag && !capabilities.rag.available) return {reason: capabilities.rag.reason || 'База знаний сейчас недоступна. Сохранённый выбор можно изменить.'};
    if (draft.systemRoles && !capabilities.systemRoles.available) return {reason: capabilities.systemRoles.reason || 'Системная справка сейчас недоступна.'};
    if (draft.publicChats) {
        if (!capabilities.publicChats.available) return {reason: capabilities.publicChats.reason || 'Поиск публичных чатов недоступен.'};
        if (!draft.model) return {reason: 'Выберите embedding-модель для публичных чатов.'};
        if (!capabilities.publicChats.models.some(model => model.id === draft.model!.id && model.pin === draft.model!.pin)) return {reason: 'Выбранная версия модели изменилась или недоступна. Выберите текущую версию и подтвердите передачу заново.'};
        if (!draft.consent) return {reason: 'Подтвердите передачу запроса и публичных сообщений выбранной embedding-модели.'};
    }
    if (!draft.rag && !draft.systemRoles && !draft.publicChats) return {reason: 'Выберите источник или выключите инструменты для обычного ответа.'};
    return {request: draft.restored ? structuredClone(draft.restored) : {protocol: 'json-actions-v1',rag: draft.rag,...(draft.systemRoles ? {systemRoles: true} : {}),...(draft.publicChats ? {publicChats: {modelId: draft.model!.id,expectedModelPin: draft.model!.pin,consent: true as const,...(draft.roomId ? {roomId: draft.roomId} : {})}} : {})}};
}
