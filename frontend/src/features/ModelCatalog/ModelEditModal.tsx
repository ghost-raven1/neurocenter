import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space } from 'antd';
import { useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { modelCatalogApi } from './api';
import { modelCapabilityLabels } from './modelCatalogState';
import type { ICatalogModel, IModelCreate } from './types';
import { createBridgeRequestKey } from '../McpBridge/bridgeRequestKey';

interface IProps { model?: ICatalogModel; onClose: () => void; onSaved: (saved?: ICatalogModel) => Promise<void>; }
export const ollamaModelPattern = /^(?:[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;

/** Редактор API и метаданных; локальные веса поступают только из проверенного ассета. */
export function ModelEditModal({ model, onClose, onSaved }: IProps): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const [form] = Form.useForm<IModelCreate>();
    const capability = Form.useWatch('capability', form) ?? model?.capability ?? 'embedding';
    const runtime = Form.useWatch('runtime', form) ?? model?.runtime ?? 'remote-openai';
    const remote = runtime !== 'ollama';
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const lock = useRef(false);
    const creating = useRef<{ input: string; key: string }>();
    const submit = async (values: IModelCreate): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const identity = { name: values.name.trim(), description: values.description?.trim() ?? '' };
            const technical = { model: values.model?.trim(), ...(remote ? { modelVersion: values.modelVersion?.trim() } : {}),
                ...(capability === 'embedding' ? { dimension: values.dimension ?? null } : {}) };
            const input = { ...identity, ...technical, model: technical.model!, runtime, capability: values.capability };
            const fingerprint = JSON.stringify(input);
            if (!creating.current || creating.current.input !== fingerprint) creating.current = { input: fingerprint, key: createBridgeRequestKey() };
            const saved = model ? await modelCatalogApi.update(model, { ...identity, ...(remote ? technical : {}) })
                : await modelCatalogApi.create(input, creating.current.key);
            if (!owns()) return;
            await onSaved(saved);
            if (owns()) onClose();
        } catch (cause) {
            if (owns()) setError(errorMessage(cause, 'Не удалось сохранить модель. Введённые данные сохранены.'));
        } finally {
            lock.current = false;
            if (owns()) setBusy(false);
        }
    };
    return <Modal open centered className="model-details" title={model ? 'Изменить модель' : 'Добавить модель в каталог'} footer={null} width={600}
        onCancel={() => { if (!lock.current) onClose(); }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
        <Form form={form} name="model-catalog-edit" layout="vertical" disabled={busy}
            initialValues={model ?? { capability: 'embedding', runtime: 'remote-openai' }} onFinish={values => { void submit(values); }}>
            {error && <Alert type="error" showIcon message={error} className="model-catalog__notice" />}
            <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true, message: 'Введите название' }, { max: 128, message: 'До 128 символов' }]}>
                <Input placeholder="Например, Модель для поиска по проекту" autoFocus />
            </Form.Item>
            <Form.Item name="description" label="Описание" rules={[{ max: 4000, message: 'До 4000 символов' }]}>
                <Input.TextArea rows={3} placeholder="Для каких задач подходит модель" />
            </Form.Item>
            {!model && <Form.Item name="runtime" label="Где работает модель" rules={[{ required: true }]}>
                <Select options={[{ value: 'remote-openai', label: 'Удалённый API · OpenAI совместимый' }, { value: 'remote-ollama', label: 'Удалённый API · Ollama' }]} />
            </Form.Item>}
            {(!model || remote) && <>
                {!model &&
                <Form.Item name="capability" label="Назначение" rules={[{ required: true }]}>
                    <Select options={Object.entries(modelCapabilityLabels).map(([value, label]) => ({ value, label }))} />
                </Form.Item>}
                <Form.Item name="model" label={remote ? 'Идентификатор модели API' : 'Модель Ollama с версией'} extra={remote ? 'Точное имя модели у провайдера. Адрес и ключ задаются отдельно.' : 'Идентификатор и тег из реестра Ollama.'}
                    rules={[{ required: true, message: 'Укажите идентификатор модели' }, { pattern: remote ? /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/ : ollamaModelPattern, message: remote ? 'Идентификатор модели без адреса API' : 'Формат: qwen3:4b или автор/модель:тег' }]}>
                    <Input placeholder={remote ? 'text-embedding-3-large' : 'qwen3:4b'} />
                </Form.Item>
                {remote && <Form.Item name="modelVersion" label="Версия модели" extra="Версия или дата из документации провайдера. Изменение потребует проверки и нового индекса." rules={[{ required: true, whitespace: true, message: 'Укажите версию' }, { max: 128, message: 'До 128 символов' }]}><Input placeholder="Например, 2026-10" /></Form.Item>}
                {capability === 'embedding' && <Form.Item name="dimension" label="Размерность эмбеддинга" extra="Если известна. Смена модели не перестраивает существующие индексы."
                    rules={[{ type: 'integer', min: 1, max: 16384, message: 'Целое число от 1 до 16384' }]}>
                    <InputNumber min={1} max={16384} precision={0} style={{ width: '100%' }} placeholder="Например, 2560" />
                </Form.Item>}
            </>}
            <Space className="model-catalog__form-actions"><Button disabled={busy} onClick={onClose}>Отмена</Button><Button type="primary" htmlType="submit" loading={busy}>Сохранить</Button></Space>
        </Form>
    </Modal>;
}
