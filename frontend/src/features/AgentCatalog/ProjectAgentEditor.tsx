import { FeatureButton, useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Collapse, Form, Modal, Space, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { agentCatalogApi } from './api';
import { AgentDefinitionFields, normalizedAgentDefinition, type IAgentEditorValues } from './AgentDefinitionFields';
import { agentOverrides, agentPermissionLabels, requireAgentCatalog } from './model';
import type { IAgentProjectPatch, ICatalogAgent, IProjectAgent } from './types';
import { useUnsavedAgentPrompt } from './useUnsavedAgentPrompt';

interface IProps {
    projectId: string; assignment: IProjectAgent; revision: number;
    onClose: () => void;
    onSave: (agent: ICatalogAgent, patch: IAgentProjectPatch, revision: number) => Promise<unknown>;
}

/** Project overrides never edit the catalog template or silently move its immutable version pin. */
export function ProjectAgentEditor({ projectId, assignment, revision, onClose, onSave }: IProps): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const [form] = Form.useForm<IAgentEditorValues>();
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
    useUnsavedAgentPrompt(dirty);
    const [conflict, setConflict] = useState<{revision: number; assignment?: IProjectAgent}>();
    const reference = useRef({ assignment, revision }), lock = useRef(false), confirmation = useRef<{destroy(): void}>();
    useEffect(() => () => confirmation.current?.destroy(), []);
    const close = (): void => {
        if (lock.current) return;
        if (!dirty) { onClose(); return; }
        confirmation.current = Modal.confirm({ title: 'Закрыть без сохранения?', content: 'Изменённый промпт проекта останется несохранённым.', okText: 'Закрыть', cancelText: 'Продолжить редактирование', onOk: onClose });
    };
    const availability = useFeatureAvailability('agents');
    const submit = async (values: IAgentEditorValues): Promise<void> => {
        if (!availability.enabled) return;
        const owns = captureOwner(); if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const current = reference.current;
            const result = await onSave(current.assignment.card, { overrides: agentOverrides(current.assignment.card.definition, normalizedAgentDefinition(values.definition)) }, current.revision);
            if (owns() && result) onClose();
        } catch (cause) {
            if (!owns()) return;
            setError(errorMessage(cause, 'Настройки не сохранены. Ваш промпт остался в редакторе.'));
            if ((cause as {response?: {status?: number}})?.response?.status === 409) {
                try {
                    const latest = requireAgentCatalog(await agentCatalogApi.list(projectId));
                    if (owns() && latest.revision !== null) setConflict({ revision: latest.revision, assignment: latest.assignments.find(item => item.agentId === assignment.agentId && !item.removed) });
                } catch { /* Draft remains attached to its original pin and revision. */ }
            }
        } finally { lock.current = false; if (owns()) setBusy(false); }
    };
    const reset = (): void => {
        const base = reference.current.assignment.card.definition;
        form.setFieldsValue({ definition: { model: undefined, temperature: undefined, topP: undefined, steps: undefined, ...base,
            permission: { ...Object.fromEntries(Object.keys(agentPermissionLabels).map(key => [key, undefined])), ...base.permission } } });
        setDirty(true);
    };
    return <Modal open centered title={`Настройки проекта · ${assignment.card.name}`} className="agent-editor" width={780} footer={null}
        onCancel={close} closable={!busy} keyboard={!busy} maskClosable={false}>
        <Typography.Paragraph><Tag>Шаблон v{reference.current.assignment.version}</Tag><Typography.Text code>@{reference.current.assignment.card.slug}</Typography.Text></Typography.Paragraph>
        <Typography.Paragraph type="secondary">Промпт и параметры изменятся только в этом проекте. Общий шаблон и другие проекты сохранят свои настройки.</Typography.Paragraph>
        <Form form={form} layout="vertical" disabled={busy} name="project-agent-edit" initialValues={{ ...assignment.card, definition: assignment.effective }}
            onValuesChange={() => setDirty(true)} onFinish={values => { void submit(values); }}>
            {error && <Alert showIcon type="error" message={error} className="agent-catalog__notice" />}
            {conflict && <Alert type="warning" showIcon className="agent-catalog__notice" message={conflict.assignment ? 'Настройки проекта изменились. Ваш текст сохранён в форме.' : 'Агент уже удалён из проекта. Сохраните свой текст перед закрытием.'}
                description={conflict.assignment && <><Collapse ghost><Collapse.Panel header={`Актуальный промпт проекта · шаблон v${conflict.assignment.version}`} key="current"><pre className="agent-editor__comparison">{conflict.assignment.effective.prompt}</pre></Collapse.Panel></Collapse>
                    <FeatureButton features={['agents']} danger disabled={busy} onClick={() => { reference.current = { assignment: conflict.assignment!, revision: conflict.revision }; setConflict(undefined); form.submit(); }}>Применить мой вариант к актуальным настройкам</FeatureButton></>} />}
            <AgentDefinitionFields form={form} disabled={busy} />
            {dirty && <Typography.Paragraph type="secondary">Несохранённые настройки ещё не испытывались в чате. Испытание запускается отдельно после сохранения.</Typography.Paragraph>}
            <div className="agent-editor__actions"><Button disabled={busy} onClick={reset}>Вернуть закреплённый шаблон</Button><Space wrap><Button disabled={busy} onClick={close}>Отмена</Button><FeatureButton features={['agents']} type="primary" htmlType="submit" loading={busy}>Сохранить и применить</FeatureButton></Space></div>
        </Form>
    </Modal>;
}
