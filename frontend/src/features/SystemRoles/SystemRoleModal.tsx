import { Alert, Button, Checkbox, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { useSystemRole } from './useSystemRole';
import { RoleRunContent, rolePhaseLabel } from './RoleRunContent';
import { RoleProjectContextPreview } from './RoleProjectContext';
import { IndexerOwnerActions } from './IndexerOwnerActions';
import { diagnosticNames, pendingRole, roleCallBudget, roleFlag, roleName, targetNames, type DiagnosticKind, type RoleSelection, type SystemRoleId } from './types';
import './SystemRoles.less';

/** Opening/refreshing is free. Reviewed context/search permission and an explicit model precede every paid intent. */
export function SystemRoleModal({ id, projectId, initialRunId, onClose }: { id: SystemRoleId; projectId?: string; initialRunId?: string; onClose(): void }): JSX.Element {
    const value = useSystemRole(id, projectId, initialRunId), availability = useFeatureAvailability(roleFlag(id)), enabled = useRef(availability.enabled); enabled.current = availability.enabled;
    const { captureOwner } = useAuthRequestOwner();
    const confirmation = useRef<ReturnType<typeof Modal.confirm>>();
    useEffect(() => () => { confirmation.current?.destroy(); }, []);
    const [instruction, setInstruction] = useState(''), [modelId, setModelId] = useState<string>(), [diagnostics, setDiagnostics] = useState<DiagnosticKind[]>([]), [selected, setSelected] = useState<string[]>([]);
    const [prompt, setPrompt] = useState(''), [usePrompt, setUsePrompt] = useState(false), [consent, setConsent] = useState(false);
    const [originalSelection, setOriginalSelection] = useState<RoleSelection>(), [preparingAgain, setPreparingAgain] = useState(false);
    const identity = JSON.stringify([id, projectId ?? null]), currentIdentity = useRef(identity); currentIdentity.current = identity;
    const definition = value.overview?.definitions.find(item => item.id === id), model = value.overview?.models.find(item => item.id === modelId);
    const targets = value.overview?.targets.filter(item => definition?.targets.includes(item.kind)) ?? [];
    const targetChoices = [...targets, ...(originalSelection?.targets.filter(target => target.kind !== 'prompt' && !targets.some(item => item.kind === target.kind && item.id === target.id))
        .map(target => ({ kind: target.kind, id: target.id, name: target.id + ' · проверьте доступность' })) ?? [])];
    const originalPrompts = originalSelection?.targets.filter(target => target.kind === 'prompt') ?? [], budget = roleCallBudget(id, !!originalSelection?.mcp?.length);
    const revision = useRef(0);
    const modelChosen = useRef(false);
    const invalidate = (): void => { revision.current++; value.invalidate(); setConsent(false); };
    useEffect(() => {
        if (modelChosen.current || initialRunId || value.run || !value.overview?.models.length) return;
        modelChosen.current = true; setModelId(value.overview.models[0].id); invalidate();
    }, [value.overview?.models, initialRunId, value.run?.id]);
    useEffect(() => { invalidate(); }, [id, projectId, model?.id, model?.pin]);
    const selection = (): RoleSelection => ({ projectId: projectId ?? null, instruction, diagnostics, targets: [...targetChoices.filter(item => selected.includes(item.kind + ':' + item.id)).map(({ kind, id }) => ({ kind, id })),
        ...(usePrompt ? [{ kind: 'prompt' as const, id: originalPrompts[0]?.id ?? 'selected-text', text: prompt }, ...originalPrompts.slice(1)] : [])],
        ...(originalSelection?.mcp?.length ? { mcp: originalSelection.mcp } : {}) });
    const locked = value.busy || value.uncertain || pendingRole(value.run), ready = !!model && !!instruction.trim() && (!usePrompt || !!prompt.trim())
        && selected.length + (usePrompt ? Math.max(1, originalPrompts.length) : 0) <= 4;
    /** Restoring input is free; the existing prepare/review/start sequence establishes current authority. */
    const restoreDraft = (): void => {
        const draft = value.run?.prepareAgain;
        if (!draft || locked || currentIdentity.current !== identity || !captureOwner()() || draft.selection.projectId !== (projectId ?? null)) return;
        const source = structuredClone(draft.selection), text = source.targets.find(target => target.kind === 'prompt');
        invalidate(); modelChosen.current = true; setOriginalSelection(source); setInstruction(source.instruction); setModelId(draft.modelId); setDiagnostics(source.diagnostics);
        setSelected(source.targets.filter(target => target.kind !== 'prompt').map(target => target.kind + ':' + target.id));
        setPrompt(text?.text ?? ''); setUsePrompt(!!text); setPreparingAgain(true);
    };
    const preparedRevision = revision.current;
    const start = (): void => {
        if (revision.current !== preparedRevision || !enabled.current || !ready || locked || !consent || !value.prepared || !model || !captureOwner()()) return;
        void value.start({ ...selection(), requestId: crypto.randomUUID(), modelId: model.id, expectedModelPin: model.pin,
            expectedDefinitionPin: value.prepared.definitionPin, consentDigest: value.prepared.consentDigest });
    };
    const apply = (rollback = false): void => {
        if (!rollback && !enabled.current || locked) return; const owns = captureOwner();
        confirmation.current = Modal.confirm({ title: rollback ? 'Откатить подтверждённые изменения?' : 'Применить показанное предложение?', content: 'Владельцы проверят актуальные версии. Подключение модели и доставка на компьютер выполняются отдельно.',
            okText: rollback ? 'Откатить' : 'Применить', cancelText: 'Вернуться к проверке', onOk: () => { if (owns() && (rollback || enabled.current)) return value.action(rollback ? 'rollback' : 'apply'); } });
    };
    return <Modal open title={roleName(id)} width={1000} onCancel={onClose} footer={<Button onClick={onClose}>Закрыть</Button>} destroyOnClose>
        <div className="system-role"><Typography.Paragraph>{definition?.description ?? 'История и явный запуск системного агента.'}</Typography.Paragraph>
            {!availability.enabled && <Alert showIcon type="info" message={availability.reason} description="История, отмена и откат подтверждённых изменений остаются доступны." />}
            {value.error && <Alert showIcon type="warning" message={value.error} action={<Button onClick={() => { void value.refresh(); }}>Перечитать</Button>} />}
            {value.uncertain && <Alert showIcon type="warning" message="Подтверждение запуска потеряно" description="Повтор отправит тот же сохранённый запрос и не создаст второй платный запуск." action={<Button loading={value.busy} onClick={() => { void value.replay(); }}>Проверить тот же запрос</Button>} />}
            {id === 'agent-indexer' && !value.run && <IndexerOwnerActions projectId={projectId ?? null} />}
            <details open={!value.run || preparingAgain}><summary>Новый запуск · до {budget} вызовов модели, до 2 минут</summary><Form layout="vertical" disabled={locked}>
                {id === 'agent-coordinator' && <Alert type="info" showIcon message="Координатор выберет до трёх системных агентов" description="Каждый получит разрешённую часть выбранных данных. Доступ к базе знаний показан при подготовке контекста. Ответы и недоступные шаги сохранятся вместе; изменения применяются отдельно." />}
                <Form.Item label="Проверенная модель" required><Select aria-label="Модель системного агента" placeholder="Выберите подходящую модель" value={modelId} allowClear onChange={id => { modelChosen.current = true; setModelId(id); invalidate(); }} options={value.overview?.models.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
                <Form.Item label="Задача" required><Input.TextArea value={instruction} maxLength={2048} autoSize={{ minRows: 2, maxRows: 6 }} onChange={event => { setInstruction(event.target.value); invalidate(); }} placeholder="Что проверить или улучшить и какой результат нужен" /></Form.Item>
                {!!definition?.diagnostics.length && <Form.Item label="Разрешённые измерения"><Checkbox.Group value={diagnostics} onChange={items => { setDiagnostics(items as DiagnosticKind[]); invalidate(); }} options={definition.diagnostics.filter(kind => kind !== 'containers' || !projectId).map(kind => ({ value: kind, label: diagnosticNames[kind] }))} /></Form.Item>}
                {preparingAgain && modelId && value.overview && !model && <Alert type="info" showIcon message="Выбранная ранее модель сейчас недоступна" description="Выберите проверенную модель. Введённая задача сохранена." />}
                {!!targetChoices.length && <Form.Item label="Выбранные цели · до 4"><Select aria-label="Цели системного агента" mode="multiple" value={selected} onChange={items => { setSelected(items); invalidate(); }} options={targetChoices.map(item => ({ value: item.kind + ':' + item.id, label: targetNames[item.kind] + ': ' + item.name }))} /></Form.Item>}
                {['agent-autoconfigurator', 'agent-coordinator'].includes(id) && <><Checkbox checked={usePrompt} onChange={event => { setUsePrompt(event.target.checked); invalidate(); }}>Добавить выбранный текст промпта</Checkbox>{usePrompt && <Form.Item label="Только текст, который разрешено передать выбранной модели"><Input.TextArea value={prompt} onChange={event => { setPrompt(event.target.value); invalidate(); }} autoSize={{ minRows: 4, maxRows: 12 }} /></Form.Item>}</>}
                {originalPrompts.length > 1 && <Typography.Paragraph type="secondary">Остальные выбранные тексты сохранены и будут показаны в новом контексте.</Typography.Paragraph>}
                {!!originalSelection?.mcp?.length && <Alert type="info" showIcon message="Выбор инструментов сохранён" description="Он будет проверен заново. Проверьте список инструментов в новом контексте перед согласием." />}
                <Typography.Paragraph type="secondary">Локальные файлы напрямую не читаются. Известные приватные значения параметров скрываются маркерами; проверьте показанные данные и разрешение на поиск перед отправкой.</Typography.Paragraph>
                <Button disabled={!availability.enabled || !ready || locked} loading={value.busy} onClick={() => { if (enabled.current && !locked) { setConsent(false); void value.prepare(selection()); } }}>Подготовить контекст без вызова модели</Button>
            </Form>{value.prepared && <><Typography.Title level={5}>Контекст для модели{value.prepared.projectContext ? ' и разрешение на поиск' : ''}</Typography.Title><pre className="system-role__preview">{value.prepared.preview}</pre>
                <RoleProjectContextPreview context={value.prepared.projectContext} />
                <Checkbox checked={consent} disabled={locked} onChange={event => setConsent(event.target.checked)}>{value.prepared.projectContext ? 'Разрешаю передать показанный контекст и результаты описанного поиска выбранной модели' : 'Разрешаю передать показанный контекст выбранной модели'}</Checkbox>
                <div><Button type="primary" disabled={!availability.enabled || !ready || !consent || locked} onClick={start}>Запустить · до {budget} вызовов</Button></div></>}</details>
            <Space wrap><Button loading={value.busy} onClick={() => { void value.refresh(); }}>Обновить историю</Button><Select aria-label="История системного агента" placeholder="Выберите сохранённый запуск" value={value.run?.id} style={{ minWidth: 280 }} options={value.history.map(run => ({ value: run.id, label: new Date(run.createdAt).toLocaleString('ru-RU') + ' · ' + rolePhaseLabel(run.phase) }))} onChange={id => { const run = value.history.find(item => item.id === id); if (run) value.select(run); }} /></Space>
            {value.run && <><RoleRunContent run={value.run} />{value.run.prepareAgain && <Alert type="info" showIcon message="Системная роль обновилась. Предложение сохранено в истории."
                description="Вернитесь к исходной задаче, подготовьте текущий контекст и подтвердите новый запуск." action={<Button disabled={locked} onClick={restoreDraft}>Вернуться к подготовке</Button>} />}<Space wrap>
                {value.run.canCancel && <Button disabled={value.busy} onClick={() => { void value.action('cancel'); }}>Отменить запуск</Button>}
                {value.run.canApply && <Button type="primary" disabled={!availability.enabled || locked} onClick={() => apply()}>Применить проверенное предложение</Button>}
                {value.run.canRollback && <Button disabled={locked} onClick={() => apply(true)}>Откатить подтверждённые изменения</Button>}
            </Space></>}
        </div>
    </Modal>;
}
