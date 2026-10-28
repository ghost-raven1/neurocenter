import { Alert, Button, Checkbox, Form, Input, Select, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { diagnosticNames, roleCallBudget, roleFlag, roleName, targetNames, type DiagnosticKind, type RoleMcpSelection, type RoleSelection, type SystemRoleId } from '../SystemRoles/types';
import { McpTaskPicker } from './McpTaskPicker';
import { RoleProjectContextPreview } from '../SystemRoles/RoleProjectContext';
import type { useSystemRoleChat } from './useSystemRoleChat';
import {readRoleDraft, saveRoleDraft} from './roleDraft';
import {readRoleModelPreference, saveRoleModelPreference} from './roleModelPreference';
import type {ChatRoleAction} from '../ChatSystemRoles/types';

type ChatValue = ReturnType<typeof useSystemRoleChat>;
interface InitialTask {agentId: SystemRoleId; instruction: string; modelId?: string;}
/** Context is opt-in, visible before payment, and invalidated on every task/model/role edit. */
export function ServiceComposer({ value, projectId, canExecute = true, fixedAgentId, initial, compact = false, onActionChange }: { value: ChatValue; projectId?: string; canExecute?: boolean; fixedAgentId?: SystemRoleId; initial?: InitialTask; compact?: boolean; onActionChange?: (action?: ChatRoleAction) => void }): JSX.Element {
    const restored = value.pendingIntent;
    const chatFooter = !!fixedAgentId && !compact;
    const {scope, captureOwner} = useAuthRequestOwner();
    const [savedModel] = useState(() => fixedAgentId ? readRoleModelPreference(scope, projectId, fixedAgentId) : undefined);
    const [agentId, setAgentId] = useState<SystemRoleId>(fixedAgentId ?? restored?.agentId ?? initial?.agentId ?? 'agent-coordinator'), [modelId, setModelId] = useState<string | undefined>(restored?.input.modelId ?? initial?.modelId ?? savedModel ?? undefined);
    const [instruction, setInstruction] = useState(restored?.input.instruction ?? (initial?.instruction || (fixedAgentId ? readRoleDraft(scope, projectId, fixedAgentId) : ''))), [diagnostics, setDiagnostics] = useState<DiagnosticKind[]>([]), [selected, setSelected] = useState<string[]>([]);
    const restoredRequest = useRef(restored?.input.requestId);
    const modelChosen = useRef(!!restored || savedModel !== undefined && !initial?.modelId);
    const [mcp, setMcp] = useState<RoleMcpSelection[]>(restored?.input.mcp ?? []);
    const [includeContext, setIncludeContext] = useState(false), [prompt, setPrompt] = useState(''), [usePrompt, setUsePrompt] = useState(false), [consent, setConsent] = useState(false);
    const availability = useFeatureAvailability('system_role_chat', roleFlag(agentId), ...(fixedAgentId ? ['service_role_conversations' as const] : [])), mcpAvailability = useFeatureAvailability('system_role_mcp');
    const canStart = !(fixedAgentId && value.detail?.dialog?.legacy) && availability.enabled && canExecute && (!mcp.length || mcpAvailability.enabled), enabled = useRef(canStart); enabled.current = canStart;
    useEffect(() => {if (fixedAgentId && !restored) saveRoleDraft(scope, projectId, fixedAgentId, instruction);}, [scope, projectId, fixedAgentId, instruction, restored?.input.requestId]);
    const revision = useRef(0), definition = value.overview?.definitions.find(item => item.id === agentId);
    const targets = value.overview?.targets.filter(item => definition?.targets.includes(item.kind) && item.kind !== 'dialog-context') ?? [];
    const model = value.overview?.models.find(item => item.id === modelId), locked = value.busy || !!value.receipt;
    const invalidate = (): void => { revision.current++; value.invalidate(); setConsent(false); };
    useEffect(() => {
        if (!compact || !initial || restored || locked || instruction === initial.instruction) return;
        invalidate(); setInstruction(initial.instruction);
    }, [compact,initial?.instruction,locked,restored?.input.requestId]);
    useEffect(() => {
        if (modelChosen.current || restored || !value.overview?.models.length) return;
        const first = value.overview.models.find(item => item.id === initial?.modelId) ?? value.overview.models[0];
        modelChosen.current = true; setModelId(first.id); invalidate();
    }, [value.overview?.models, restored?.input.requestId]);
    useEffect(() => { if (!canStart) invalidate(); }, [canStart]);
    useEffect(() => { invalidate(); }, [model?.id, model?.pin, projectId, agentId]);
    useEffect(() => {
        if (!restored || restoredRequest.current === restored.input.requestId) return;
        restoredRequest.current = restored.input.requestId; modelChosen.current = true; setAgentId(restored.agentId); setModelId(restored.input.modelId); setInstruction(restored.input.instruction); setMcp(restored.input.mcp ?? []);
    }, [restored?.input.requestId]);
    const diagnosticsLimit = value.overview?.budget?.diagnostics ?? 0, diagnosticsOverLimit = diagnostics.length > diagnosticsLimit;
    const aligned = !compact || !initial || !!restored || initial.instruction === instruction;
    const ready = aligned && !!definition && !!model && !!instruction.trim() && !diagnosticsOverLimit && (!usePrompt || !!prompt.trim()) && selected.length + Number(usePrompt) + Number(includeContext) <= 4;
    const selection = (): RoleSelection => ({ projectId: projectId ?? null, instruction, diagnostics,
        targets: [...targets.filter(item => selected.includes(item.kind + ':' + item.id)).map(({ kind, id }) => ({ kind, id })), ...(usePrompt ? [{ kind: 'prompt' as const, id: 'selected-text', text: prompt }] : [])], ...(mcp.length ? { mcp } : {}) });
    const hasAnswers = value.detail?.turns.some(turn => !!turn.run?.result && ['succeeded', 'awaiting_review'].includes(turn.run.state));
    const submit = (): void => {
        if (!enabled.current || locked || !ready || !consent || !value.prepared || !captureOwner()()) return;
        void value.start(model!.id);
    };
    const preparedRevision = revision.current;
    const prepare = (): void => {
        if (!enabled.current || locked || !ready || !captureOwner()() || !model) return;
        invalidate(); void value.prepare(agentId, selection(), includeContext, model.id);
    };
    const action: ChatRoleAction = {label: value.prepared ? 'Отправить задачу' : 'Проверить контекст', busy: value.busy,
        disabled: !canStart || !ready || locked || !!value.prepared && !consent,
        onClick: value.prepared ? () => {if (revision.current === preparedRevision) submit();} : prepare};
    const currentAction = useRef(action); currentAction.current = action;
    const alive = useRef(true), invokeAction = useRef(() => {if (alive.current) currentAction.current.onClick();});
    useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
    useEffect(() => {
        if (!onActionChange) return;
        onActionChange({...action,onClick: invokeAction.current});
        return () => onActionChange(undefined);
    }, [onActionChange,action.label,action.busy,action.disabled]);
    const showPrepareContext = !onActionChange && !(chatFooter && value.receipt) && (!compact && !chatFooter || !value.prepared);
    const unavailableModel = !!modelId && !!value.overview && !model;
    const modelField = <Form.Item label={chatFooter ? undefined : 'Модель для этой задачи'} required={!chatFooter} className="service-chat__model-field"><Select aria-label={compact ? 'Модель системной задачи' : fixedAgentId ? 'Модель чата роли' : 'Модель сервисного чата'} aria-required value={modelId} placeholder="Выберите проверенную модель" showSearch optionFilterProp="label" allowClear size={chatFooter ? 'small' : undefined}
        options={[...(value.overview?.models.map(item => ({ value: item.id, label: item.name })) ?? []), ...(unavailableModel ? [{value: modelId!, label: 'Ранее выбранная модель недоступна', disabled: true}] : [])]} onChange={id => {
            if (!captureOwner()() || id !== undefined && !value.overview?.models.some(item => item.id === id)) return;
            modelChosen.current = true; invalidate(); setModelId(id); if (fixedAgentId) saveRoleModelPreference(scope, projectId, fixedAgentId, id);
        }} /></Form.Item>;
    const taskField = <Form.Item label={chatFooter ? undefined : 'Задача'} required={!chatFooter}><Input.TextArea aria-label={fixedAgentId ? `Сообщение · ${roleName(fixedAgentId)}` : compact ? 'Задача системному агенту' : 'Задача сервисного чата'} aria-required value={instruction} maxLength={2048} autoSize={{ minRows: chatFooter ? 1 : 2, maxRows: compact || chatFooter ? 3 : 5 }} placeholder="Что проверить или улучшить?"
        onChange={event => { invalidate(); setInstruction(event.target.value); }} /></Form.Item>;
    const tools = <McpTaskPicker projectId={projectId} value={mcp} disabled={locked} canExecute={canExecute && availability.enabled} onChange={items => { invalidate(); setMcp(items); }} />;
    const coordinatorNote = agentId === 'agent-coordinator' && <Typography.Paragraph type="secondary">Координатор соберёт ответы до трёх системных агентов. Применение изменений подтверждается отдельно.</Typography.Paragraph>;
    return <section className={'service-chat__composer' + (chatFooter ? ' service-chat__composer_compact' : '') + (chatFooter && value.receipt ? ' service-chat__composer_pending' : '')} aria-label="Новая задача системному агенту">
        {!availability.enabled && <Alert type="info" showIcon message={availability.reason} description="История, проверка отправки, отмена и откат остаются доступны." />}
        {!canExecute && <Alert type="info" showIcon message="Новые задачи доступны администратору проекта" description="Вы можете читать свою историю, проверять отправку и отменять принятые задачи." />}
        <Form layout="vertical" disabled={locked}>
            {chatFooter ? <div className="service-chat__choices service-chat__model-row"><Typography.Text type="secondary">Модель</Typography.Text>{modelField}</div> : <details open={!compact || !model} className="service-chat__task-settings"><summary hidden={!compact}>{roleName(agentId)} · {model?.name ?? 'Выберите модель'}</summary>
            <div className="service-chat__choices">
                {!fixedAgentId && <Form.Item label="Системный агент"><Select aria-label="Системный агент" value={agentId} options={(value.overview?.definitions ?? []).map(item => ({ value: item.id, label: roleName(item.id) }))}
                    onChange={id => { invalidate(); setAgentId(id); setDiagnostics([]); setSelected([]); setUsePrompt(false); setIncludeContext(false); setMcp([]); }} /></Form.Item>}
                {modelField}
            </div>
            </details>}
            {!chatFooter && coordinatorNote}
            {unavailableModel && !!value.overview?.models.length && <Alert type="warning" showIcon message={restored ? 'Модель сохранённого запроса сейчас недоступна' : 'Ранее выбранная модель сейчас недоступна'} description={restored ? 'Исходный запрос сохранён. Проверьте его отправку в истории.' : 'Выберите доступную модель перед подготовкой контекста. Текст задачи сохранён.'} />}
            {value.overview && !value.overview.models.length && <Alert type="warning" showIcon message="Нет проверенной модели" description="Подключите модель и проверьте её API в каталоге моделей. История диалогов доступна." />}
            {!compact && taskField}
            <div className={chatFooter ? 'service-chat__options' : undefined}>
            <details className="service-chat__context"><summary>{compact ? 'Данные и инструменты' : 'Контекст задачи'}</summary>
                {chatFooter && coordinatorNote}
                {!!definition?.diagnostics.length && <Form.Item label="Разрешённые измерения"><Checkbox.Group value={diagnostics} options={definition.diagnostics.filter(kind => kind !== 'containers' || !projectId).map(kind => ({ value: kind, label: diagnosticNames[kind] }))}
                    onChange={items => { invalidate(); setDiagnostics(items as DiagnosticKind[]); }} /></Form.Item>}
                {diagnosticsOverLimit && <Typography.Paragraph type="danger">Выберите не более {diagnosticsLimit} измерений.</Typography.Paragraph>}
                {!!targets.length && <Form.Item label="Выбранные цели · до 4"><Select aria-label="Цели сервисной задачи" mode="multiple" value={selected} options={targets.map(item => ({ value: item.kind + ':' + item.id, label: targetNames[item.kind] + ': ' + item.name }))}
                    onChange={items => { invalidate(); setSelected(items); }} /></Form.Item>}
                {hasAnswers && <Checkbox checked={includeContext} onChange={event => { invalidate(); setIncludeContext(event.target.checked); }}>Добавить завершённые ответы этого диалога</Checkbox>}
                {definition?.targets.includes('prompt') && <><Checkbox checked={usePrompt} onChange={event => { invalidate(); setUsePrompt(event.target.checked); }}>Добавить выбранный текст</Checkbox>
                    {usePrompt && <Form.Item label="Текст, который разрешено передать модели"><Input.TextArea value={prompt} autoSize={{ minRows: 3, maxRows: 8 }} onChange={event => { invalidate(); setPrompt(event.target.value); }} /></Form.Item>}</>}
                <Typography.Paragraph type="secondary">{compact ? 'История переписки и документы не добавляются автоматически. Выберите нужные данные; перед отправкой мы покажем их вам.' : 'Тексты целей и завершённые ответы передаются по вашему выбору; ответы берутся из открытого личного диалога роли. Разрешение на поиск по всему индексу проекта показано при подготовке контекста.'}</Typography.Paragraph>
                {compact && tools}
            </details>
            {!compact && tools}
            </div>
            {showPrepareContext && <Button type={compact || chatFooter ? 'primary' : 'default'} disabled={!canStart || !ready || locked} loading={value.busy} onClick={prepare}>Проверить контекст</Button>}
        </Form>
        {value.prepared && <div className="service-chat__confirmation">
            {compact && <><Typography.Paragraph>Получатель: {roleName(agentId)} · {model?.name}. Передаётся задача из поля сообщения{value.prepared.selection.targets.length ? ` и выбранные данные: ${value.prepared.selection.targets.length}` : ''}.</Typography.Paragraph>
                {value.prepared.prepared.guidance && <Typography.Paragraph>Роль прочитает справку и проверит доступное состояние проекта: индекс, модель, ваши мосты, очередь и обучение. Настройки изменяются только отдельным подтверждённым действием.</Typography.Paragraph>}
                {!!diagnostics.length && <Typography.Paragraph>Дополнительные проверки: {diagnostics.map(kind => diagnosticNames[kind]).join(', ')}.</Typography.Paragraph>}
                {!!mcp.length && <Typography.Paragraph>Разрешены только выбранные инструменты: {mcp.flatMap(target => target.tools.map(tool => tool.name)).join(', ')}.</Typography.Paragraph>}</>}
            <details open={!compact && !chatFooter}><summary>{compact ? 'Точный состав передаваемых данных' : 'Контекст для выбранной модели'}</summary><div className={chatFooter ? 'service-chat__review-data' : undefined} tabIndex={chatFooter ? 0 : undefined} aria-label={chatFooter ? 'Состав подготовленного контекста' : undefined}><pre>{value.prepared.prepared.preview}</pre>{chatFooter && <RoleProjectContextPreview context={value.prepared.prepared.projectContext} />}</div></details>
            {!chatFooter && <RoleProjectContextPreview context={value.prepared.prepared.projectContext} />}
            <Checkbox checked={consent} disabled={locked || !canStart} onChange={event => setConsent(event.target.checked)}>{value.prepared.prepared.projectContext ? 'Разрешаю передать показанный контекст и результаты описанного поиска выбранной модели' : 'Разрешаю передать показанный контекст выбранной модели'}</Checkbox>
            {compact && <Typography.Paragraph type="secondary">{roleName(agentId)} · {model?.name}. До {roleCallBudget(agentId, !!mcp.length)} обращений к модели.</Typography.Paragraph>}
            {!onActionChange && <Button type="primary" disabled={!canStart || locked || !ready || !consent} onClick={() => { if (revision.current === preparedRevision) submit(); }}>{compact ? 'Отправить задачу' : `Отправить · до ${roleCallBudget(agentId, !!mcp.length)} вызовов модели`}</Button>}
        </div>}
    </section>;
}
