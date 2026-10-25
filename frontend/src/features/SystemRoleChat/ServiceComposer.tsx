import { Alert, Button, Checkbox, Form, Input, Select, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { diagnosticNames, roleCallBudget, roleFlag, roleName, targetNames, type DiagnosticKind, type RoleMcpSelection, type RoleSelection, type SystemRoleId } from '../SystemRoles/types';
import { McpTaskPicker } from './McpTaskPicker';
import { RoleProjectContextPreview } from '../SystemRoles/RoleProjectContext';
import type { useSystemRoleChat } from './useSystemRoleChat';

type ChatValue = ReturnType<typeof useSystemRoleChat>;
interface InitialTask {agentId: SystemRoleId; instruction: string; modelId?: string;}
/** Context is opt-in, visible before payment, and invalidated on every task/model/role edit. */
export function ServiceComposer({ value, projectId, canExecute = true, initial, compact = false }: { value: ChatValue; projectId?: string; canExecute?: boolean; initial?: InitialTask; compact?: boolean }): JSX.Element {
    const restored = value.pendingIntent;
    const [agentId, setAgentId] = useState<SystemRoleId>(restored?.agentId ?? initial?.agentId ?? 'agent-coordinator'), [modelId, setModelId] = useState<string | undefined>(restored?.input.modelId ?? initial?.modelId);
    const [instruction, setInstruction] = useState(restored?.input.instruction ?? initial?.instruction ?? ''), [diagnostics, setDiagnostics] = useState<DiagnosticKind[]>([]), [selected, setSelected] = useState<string[]>([]);
    const restoredRequest = useRef(restored?.input.requestId);
    const [mcp, setMcp] = useState<RoleMcpSelection[]>(restored?.input.mcp ?? []);
    const [includeContext, setIncludeContext] = useState(false), [prompt, setPrompt] = useState(''), [usePrompt, setUsePrompt] = useState(false), [consent, setConsent] = useState(false);
    const availability = useFeatureAvailability('system_role_chat', roleFlag(agentId)), mcpAvailability = useFeatureAvailability('system_role_mcp'), { captureOwner } = useAuthRequestOwner();
    const canStart = availability.enabled && canExecute && (!mcp.length || mcpAvailability.enabled), enabled = useRef(canStart); enabled.current = canStart;
    const revision = useRef(0), definition = value.overview?.definitions.find(item => item.id === agentId);
    const targets = value.overview?.targets.filter(item => definition?.targets.includes(item.kind) && item.kind !== 'dialog-context') ?? [];
    const model = value.overview?.models.find(item => item.id === modelId), locked = value.busy || !!value.receipt;
    const invalidate = (): void => { revision.current++; value.invalidate(); setConsent(false); };
    useEffect(() => { if (!canStart) invalidate(); }, [canStart]);
    useEffect(() => { invalidate(); }, [model?.id, model?.pin, projectId, agentId]);
    useEffect(() => {
        if (!restored || restoredRequest.current === restored.input.requestId) return;
        restoredRequest.current = restored.input.requestId; setAgentId(restored.agentId); setModelId(restored.input.modelId); setInstruction(restored.input.instruction); setMcp(restored.input.mcp ?? []);
    }, [restored?.input.requestId]);
    const diagnosticsLimit = value.overview?.budget?.diagnostics ?? 0, diagnosticsOverLimit = diagnostics.length > diagnosticsLimit;
    const ready = !!definition && !!model && !!instruction.trim() && !diagnosticsOverLimit && (!usePrompt || !!prompt.trim()) && selected.length + Number(usePrompt) + Number(includeContext) <= 4;
    const selection = (): RoleSelection => ({ projectId: projectId ?? null, instruction, diagnostics,
        targets: [...targets.filter(item => selected.includes(item.kind + ':' + item.id)).map(({ kind, id }) => ({ kind, id })), ...(usePrompt ? [{ kind: 'prompt' as const, id: 'selected-text', text: prompt }] : [])], ...(mcp.length ? { mcp } : {}) });
    const hasAnswers = value.detail?.turns.some(turn => !!turn.run?.result && ['succeeded', 'awaiting_review'].includes(turn.run.state));
    const submit = (): void => {
        if (!enabled.current || locked || !ready || !consent || !value.prepared || !captureOwner()()) return;
        void value.start(model!.id);
    };
    const preparedRevision = revision.current;
    const taskField = <Form.Item label="Задача" required><Input.TextArea aria-label={compact ? 'Задача системному агенту' : 'Задача сервисного чата'} value={instruction} maxLength={2048} autoSize={{ minRows: 2, maxRows: compact ? 3 : 5 }} placeholder="Что проверить или улучшить?"
        onChange={event => { invalidate(); setInstruction(event.target.value); }} /></Form.Item>;
    const tools = <McpTaskPicker projectId={projectId} value={mcp} disabled={locked} canExecute={canExecute && availability.enabled} onChange={items => { invalidate(); setMcp(items); }} />;
    return <section className="service-chat__composer" aria-label="Новая задача системному агенту">
        {!availability.enabled && <Alert type="info" showIcon message={availability.reason} description="История, проверка отправки, отмена и откат остаются доступны." />}
        {!canExecute && <Alert type="info" showIcon message="Новые задачи доступны администратору проекта" description="Вы можете читать свою историю, проверять отправку и отменять принятые задачи." />}
        <Form layout="vertical" disabled={locked}>
            {compact && taskField}
            <details open={!compact || !model} className="service-chat__task-settings"><summary hidden={!compact}>{roleName(agentId)} · {model?.name ?? 'Выберите модель'}</summary>
            <div className="service-chat__choices">
                <Form.Item label="Системный агент"><Select aria-label="Системный агент" value={agentId} options={(value.overview?.definitions ?? []).map(item => ({ value: item.id, label: roleName(item.id) }))}
                    onChange={id => { invalidate(); setAgentId(id); setDiagnostics([]); setSelected([]); setUsePrompt(false); setIncludeContext(false); setMcp([]); }} /></Form.Item>
                <Form.Item label="Модель для этой задачи" required><Select aria-label={compact ? 'Модель системной задачи' : 'Модель сервисного чата'} value={modelId} placeholder="Выберите проверенную модель" showSearch optionFilterProp="label"
                    options={value.overview?.models.map(item => ({ value: item.id, label: item.name }))} onChange={id => { invalidate(); setModelId(id); }} /></Form.Item>
            </div>
            </details>
            {agentId === 'agent-coordinator' && <Typography.Paragraph type="secondary">Координатор соберёт ответы до трёх системных агентов. Применение изменений подтверждается отдельно.</Typography.Paragraph>}
            {value.overview && !value.overview.models.length && <Alert type="warning" showIcon message="Нет проверенной модели" description="Подключите модель и проверьте её API в каталоге моделей. История диалогов доступна." />}
            {!compact && taskField}
            <details className="service-chat__context"><summary>{compact ? 'Данные и инструменты' : 'Контекст задачи'}</summary>
                {!!definition?.diagnostics.length && <Form.Item label="Разрешённые измерения"><Checkbox.Group value={diagnostics} options={definition.diagnostics.filter(kind => kind !== 'containers' || !projectId).map(kind => ({ value: kind, label: diagnosticNames[kind] }))}
                    onChange={items => { invalidate(); setDiagnostics(items as DiagnosticKind[]); }} /></Form.Item>}
                {diagnosticsOverLimit && <Typography.Paragraph type="danger">Выберите не более {diagnosticsLimit} измерений.</Typography.Paragraph>}
                {!!targets.length && <Form.Item label="Выбранные цели · до 4"><Select aria-label="Цели сервисной задачи" mode="multiple" value={selected} options={targets.map(item => ({ value: item.kind + ':' + item.id, label: targetNames[item.kind] + ': ' + item.name }))}
                    onChange={items => { invalidate(); setSelected(items); }} /></Form.Item>}
                {hasAnswers && <Checkbox checked={includeContext} onChange={event => { invalidate(); setIncludeContext(event.target.checked); }}>Добавить завершённые ответы этого диалога</Checkbox>}
                {definition?.targets.includes('prompt') && <><Checkbox checked={usePrompt} onChange={event => { invalidate(); setUsePrompt(event.target.checked); }}>Добавить выбранный текст</Checkbox>
                    {usePrompt && <Form.Item label="Текст, который разрешено передать модели"><Input.TextArea value={prompt} autoSize={{ minRows: 3, maxRows: 8 }} onChange={event => { invalidate(); setPrompt(event.target.value); }} /></Form.Item>}</>}
                <Typography.Paragraph type="secondary">{compact ? 'История переписки и документы не добавляются автоматически. Выберите нужные данные; перед отправкой мы покажем их вам.' : 'Тексты целей и завершённые ответы передаются по вашему выбору; ответы берутся из открытого личного сервисного диалога. Разрешение на поиск по всему индексу проекта показано при подготовке контекста.'}</Typography.Paragraph>
                {compact && tools}
            </details>
            {!compact && tools}
            {(!compact || !value.prepared) && <Button type={compact ? 'primary' : 'default'} disabled={!canStart || !ready || locked} loading={value.busy} onClick={() => {
                if (!enabled.current || locked || !captureOwner()() || !model) return; invalidate(); void value.prepare(agentId, selection(), includeContext, model.id);
            }}>Проверить контекст</Button>}
        </Form>
        {value.prepared && <div className="service-chat__confirmation"><details open><summary>Контекст для выбранной модели</summary><pre>{value.prepared.prepared.preview}</pre></details>
            <RoleProjectContextPreview context={value.prepared.prepared.projectContext} />
            <Checkbox checked={consent} disabled={locked || !canStart} onChange={event => setConsent(event.target.checked)}>{value.prepared.prepared.projectContext ? 'Разрешаю передать показанный контекст и результаты описанного поиска выбранной модели' : 'Разрешаю передать показанный контекст выбранной модели'}</Checkbox>
            {compact && <Typography.Paragraph type="secondary">{roleName(agentId)} · {model?.name}. До {roleCallBudget(agentId, !!mcp.length)} обращений к модели.</Typography.Paragraph>}
            <Button type="primary" disabled={!canStart || locked || !ready || !consent} onClick={() => { if (revision.current === preparedRevision) submit(); }}>{compact ? 'Отправить задачу' : `Отправить · до ${roleCallBudget(agentId, !!mcp.length)} вызовов модели`}</Button>
        </div>}
    </section>;
}
