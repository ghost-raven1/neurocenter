import { Alert, Button, Checkbox, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { useSystemRole } from './useSystemRole';
import { RoleRunContent, rolePhaseLabel } from './RoleRunContent';
import { diagnosticNames, pendingRole, roleFlag, roleName, targetNames, type DiagnosticKind, type RoleSelection, type SystemRoleId } from './types';
import './SystemRoles.less';

/** Opening/refreshing is free. A prepared exact context and explicit model choice precede every new paid intent. */
export function SystemRoleModal({ id, projectId, initialRunId, onClose }: { id: SystemRoleId; projectId?: string; initialRunId?: string; onClose(): void }): JSX.Element {
    const value = useSystemRole(id, projectId, initialRunId), availability = useFeatureAvailability(roleFlag(id)), enabled = useRef(availability.enabled); enabled.current = availability.enabled;
    const { captureOwner } = useAuthRequestOwner();
    const confirmation = useRef<ReturnType<typeof Modal.confirm>>();
    useEffect(() => () => { confirmation.current?.destroy(); }, []);
    const [instruction, setInstruction] = useState(''), [modelId, setModelId] = useState<string>(), [diagnostics, setDiagnostics] = useState<DiagnosticKind[]>([]), [selected, setSelected] = useState<string[]>([]);
    const [prompt, setPrompt] = useState(''), [usePrompt, setUsePrompt] = useState(false), [consent, setConsent] = useState(false);
    const definition = value.overview?.definitions.find(item => item.id === id), model = value.overview?.models.find(item => item.id === modelId);
    const targets = value.overview?.targets.filter(item => definition?.targets.includes(item.kind)) ?? [];
    const invalidate = (): void => { value.invalidate(); setConsent(false); };
    const selection = (): RoleSelection => ({ projectId: projectId ?? null, instruction, diagnostics, targets: [...targets.filter(item => selected.includes(item.kind + ':' + item.id)).map(({ kind, id }) => ({ kind, id })), ...(usePrompt ? [{ kind: 'prompt' as const, id: 'selected-text', text: prompt }] : [])] });
    const locked = value.busy || value.uncertain || pendingRole(value.run), ready = !!model && !!instruction.trim() && (!usePrompt || !!prompt.trim()) && selected.length + Number(usePrompt) <= 4;
    const start = (): void => {
        if (!enabled.current || !ready || locked || !consent || !value.prepared || !model || !captureOwner()()) return;
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
            <details open={!value.run}><summary>Новый запуск · до 2 вызовов модели, до 2 минут</summary><Form layout="vertical" disabled={locked}>
                <Form.Item label="Проверенная модель" required><Select aria-label="Модель системного агента" placeholder="Выберите модель явно" value={modelId} onChange={id => { setModelId(id); invalidate(); }} options={value.overview?.models.map(item => ({ value: item.id, label: item.name }))} /></Form.Item>
                <Form.Item label="Задача" required><Input.TextArea value={instruction} maxLength={2048} autoSize={{ minRows: 2, maxRows: 6 }} onChange={event => { setInstruction(event.target.value); invalidate(); }} placeholder="Что проверить или улучшить и какой результат нужен" /></Form.Item>
                {!!definition?.diagnostics.length && <Form.Item label="Разрешённые измерения"><Checkbox.Group value={diagnostics} onChange={items => { setDiagnostics(items as DiagnosticKind[]); invalidate(); }} options={definition.diagnostics.filter(kind => kind !== 'containers' || !projectId).map(kind => ({ value: kind, label: diagnosticNames[kind] }))} /></Form.Item>}
                {!!targets.length && <Form.Item label="Выбранные цели · до 4"><Select aria-label="Цели системного агента" mode="multiple" value={selected} onChange={items => { setSelected(items); invalidate(); }} options={targets.map(item => ({ value: item.kind + ':' + item.id, label: targetNames[item.kind] + ': ' + item.name }))} /></Form.Item>}
                {id === 'agent-autoconfigurator' && <><Checkbox checked={usePrompt} onChange={event => { setUsePrompt(event.target.checked); invalidate(); }}>Добавить выбранный текст промпта</Checkbox>{usePrompt && <Form.Item label="Только текст, который разрешено передать выбранной модели"><Input.TextArea value={prompt} onChange={event => { setPrompt(event.target.value); invalidate(); }} autoSize={{ minRows: 4, maxRows: 12 }} /></Form.Item>}</>}
                <Typography.Paragraph type="secondary">Автоматического чтения локальных файлов и секретов нет. Приватные значения параметров остаются скрытыми маркерами; проверьте весь контекст перед отправкой.</Typography.Paragraph>
                <Button disabled={!availability.enabled || !ready || locked} loading={value.busy} onClick={() => { if (enabled.current && !locked) { setConsent(false); void value.prepare(selection()); } }}>Подготовить контекст без вызова модели</Button>
            </Form>{value.prepared && <><Typography.Title level={5}>Точный контекст для модели</Typography.Title><pre className="system-role__preview">{value.prepared.preview}</pre>
                <Checkbox checked={consent} disabled={locked} onChange={event => setConsent(event.target.checked)}>Разрешаю передать показанный контекст выбранной модели</Checkbox>
                <div><Button type="primary" disabled={!availability.enabled || !ready || !consent || locked} onClick={start}>Запустить · до 2 вызовов</Button></div></>}</details>
            <Space wrap><Button loading={value.busy} onClick={() => { void value.refresh(); }}>Обновить историю</Button><Select aria-label="История системного агента" placeholder="Выберите сохранённый запуск" value={value.run?.id} style={{ minWidth: 280 }} options={value.history.map(run => ({ value: run.id, label: new Date(run.createdAt).toLocaleString('ru-RU') + ' · ' + rolePhaseLabel(run.phase) }))} onChange={id => { const run = value.history.find(item => item.id === id); if (run) value.select(run); }} /></Space>
            {value.run && <><RoleRunContent run={value.run} /><Space wrap>
                {value.run.canCancel && <Button disabled={value.busy} onClick={() => { void value.action('cancel'); }}>Отменить запуск</Button>}
                {value.run.canApply && <Button type="primary" disabled={!availability.enabled || locked} onClick={() => apply()}>Применить проверенное предложение</Button>}
                {value.run.canRollback && <Button disabled={locked} onClick={() => apply(true)}>Откатить подтверждённые изменения</Button>}
            </Space></>}
        </div>
    </Modal>;
}
