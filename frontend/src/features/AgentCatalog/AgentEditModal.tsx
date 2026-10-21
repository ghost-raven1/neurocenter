import { FeatureButton, useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Collapse, Form, Input, Modal, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { createBridgeRequestKey } from '../McpBridge/bridgeRequestKey';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { agentCatalogApi } from './api';
import { AgentDefinitionFields, normalizedAgentDefinition, type IAgentEditorValues } from './AgentDefinitionFields';
import { agentSlugPattern, defaultAgentPermission, validAgentText } from './model';
import type { ICatalogAgent } from './types';
import { useUnsavedAgentPrompt } from './useUnsavedAgentPrompt';
import './AgentCatalog.less';

interface IProps { agent?: ICatalogAgent; onClose: () => void; onSaved: (agent: ICatalogAgent) => Promise<void> }
const initialSlug = (): string => { try { return 'nc-agent-' + crypto.randomUUID().slice(0, 8); } catch { return ''; } };

/** Form text survives transport/CAS failures; replacing a newer template requires an explicit review. */
export function AgentEditModal({ agent, onClose, onSaved }: IProps): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const [form] = Form.useForm<IAgentEditorValues>();
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
    useUnsavedAgentPrompt(dirty);
    const [conflict, setConflict] = useState<ICatalogAgent>();
    const [slug] = useState(initialSlug);
    const lock = useRef(false), expected = useRef(agent);
    const request = useRef<{ fingerprint: string; key: string }>();
    const confirmation = useRef<{destroy(): void}>();
    useEffect(() => () => confirmation.current?.destroy(), []);
    const close = (): void => {
        if (lock.current) return;
        if (!dirty) { onClose(); return; }
        confirmation.current = Modal.confirm({ title: 'Закрыть без сохранения?', content: 'Изменённый промпт останется несохранённым.', okText: 'Закрыть', cancelText: 'Продолжить редактирование', onOk: onClose });
    };
    const availability = useFeatureAvailability('agents');
    const submit = async (values: IAgentEditorValues): Promise<void> => {
        if (!availability.enabled) return;
        const owns = captureOwner(); if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const definition = normalizedAgentDefinition(values.definition);
            const input = { slug: values.slug, name: values.name.trim(), description: definition.description, definition };
            const fingerprint = JSON.stringify([expected.current?.id, expected.current?.version, input]);
            if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: createBridgeRequestKey() };
            const saved = expected.current ? await agentCatalogApi.update(expected.current, input, request.current.key) : await agentCatalogApi.create(input, request.current.key);
            if (!owns()) return;
            await onSaved(saved);
            if (owns()) onClose();
        } catch (cause) {
            if (!owns()) return;
            setError(errorMessage(cause, 'Не удалось сохранить агента. Ваш промпт остался в редакторе; повтор использует тот же запрос.'));
            if (expected.current && (cause as {response?: {status?: number}})?.response?.status === 409) {
                try { const latest = await agentCatalogApi.get(expected.current.id); if (owns() && latest.version > expected.current.version) setConflict(latest); } catch { /* Main error and draft remain visible. */ }
            }
        } finally { lock.current = false; if (owns()) setBusy(false); }
    };
    return <Modal open centered title={agent ? 'Изменить агента в каталоге' : 'Добавить агента в каталог'} className="agent-editor" width={780} footer={null}
        onCancel={close} closable={!busy} keyboard={!busy} maskClosable={false}>
        <Form form={form} layout="vertical" disabled={busy} name="agent-template-edit" onValuesChange={() => setDirty(true)} onFinish={values => { void submit(values); }}
            initialValues={agent ? { ...agent, definition: agent.definition } : { slug, name: '', definition: { description: '', prompt: '', mode: 'subagent', permission: defaultAgentPermission } }}>
            {error && <Alert type="error" showIcon message={error} className="agent-catalog__notice" />}
            {conflict && <Alert type="warning" showIcon className="agent-catalog__notice" message={`В каталоге уже версия ${conflict.version}. Ваш текст сохранён в форме.`}
                description={<><Collapse ghost><Collapse.Panel header="Посмотреть актуальный промпт" key="current"><Typography.Paragraph>{conflict.name} · {conflict.description}</Typography.Paragraph><pre className="agent-editor__comparison">{conflict.definition.prompt}</pre></Collapse.Panel></Collapse>
                    <FeatureButton features={['agents']} danger disabled={busy || !!conflict.archivedAt} onClick={() => { expected.current = conflict; setConflict(undefined); form.submit(); }}>Сохранить мой вариант поверх версии {conflict.version}</FeatureButton></>} />}
            <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true, message: 'Введите название' }, { max: 128, message: 'До 128 символов' }, { validator: (_, value?: string) => !value || validAgentText(value) ? Promise.resolve() : Promise.reject(new Error('Название должно быть одной строкой корректного UTF-8')) }]}><Input autoFocus placeholder="Например, Ревьюер" /></Form.Item>
            <Form.Item name="slug" label="Имя в OpenCode" extra="Отдельное имя nc-… сохраняет встроенные Build и Plan. Вызов подагента: @имя."
                rules={[{ required: true, message: 'Укажите имя в OpenCode' }, { max: 64, message: 'До 64 символов' }, { pattern: agentSlugPattern, message: 'Начните с nc-; затем латиница, цифры и дефисы' }]}><Input prefix="@" placeholder="nc-reviewer" /></Form.Item>
            <AgentDefinitionFields form={form} disabled={busy} />
            <div className="agent-editor__actions"><Typography.Text type="secondary">Изменения не переписывают закреплённые настройки проектов.</Typography.Text><Space wrap><Button disabled={busy} onClick={close}>Отмена</Button><FeatureButton features={['agents']} type="primary" htmlType="submit" loading={busy}>Сохранить агента</FeatureButton></Space></div>
        </Form>
    </Modal>;
}
