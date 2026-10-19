import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space } from 'antd';
import { useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { modelCatalogApi } from './api';
import { modelCapabilityLabels } from './modelCatalogState';
import type { ICatalogModel, IModelCreate } from './types';

interface IProps { model?: ICatalogModel; onClose: () => void; onSaved: () => Promise<void>; }
export const ollamaModelPattern = /^(?:[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i;

/** Технический идентификатор неизменяем: другое семейство или версия создаёт отдельную карточку. */
export function ModelEditModal({ model, onClose, onSaved }: IProps): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const [form] = Form.useForm<IModelCreate>();
    const capability = Form.useWatch('capability', form) ?? 'embedding';
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const lock = useRef(false);
    const submit = async (values: IModelCreate): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            const identity = { name: values.name.trim(), description: values.description?.trim() ?? '' };
            if (model) await modelCatalogApi.update(model, identity);
            else await modelCatalogApi.create({ ...identity, model: values.model.trim(), capability: values.capability,
                ...(values.capability === 'embedding' && values.dimension ? { dimension: values.dimension } : {}) });
            if (!owns()) return;
            await onSaved();
            if (owns()) onClose();
        } catch (cause) {
            if (owns()) setError(errorMessage(cause, 'Не удалось сохранить модель. Введённые данные сохранены.'));
        } finally {
            lock.current = false;
            if (owns()) setBusy(false);
        }
    };
    return <Modal open title={model ? 'Изменить модель' : 'Добавить модель в каталог'} footer={null} width={600}
        onCancel={() => { if (!lock.current) onClose(); }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
        <Form form={form} name="model-catalog-edit" layout="vertical" disabled={busy}
            initialValues={model ?? { capability: 'embedding' }} onFinish={values => { void submit(values); }}>
            {error && <Alert type="error" showIcon message={error} className="model-catalog__notice" />}
            <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true, message: 'Введите название' }, { max: 128, message: 'До 128 символов' }]}>
                <Input placeholder="Например, Модель для поиска по проекту" autoFocus />
            </Form.Item>
            <Form.Item name="description" label="Описание" rules={[{ max: 4000, message: 'До 4000 символов' }]}>
                <Input.TextArea rows={3} placeholder="Для каких задач подходит модель" />
            </Form.Item>
            {!model && <>
                <Form.Item name="capability" label="Назначение" rules={[{ required: true }]}>
                    <Select options={Object.entries(modelCapabilityLabels).map(([value, label]) => ({ value, label }))} />
                </Form.Item>
                <Form.Item name="model" label="Модель Ollama с версией" extra="Укажите идентификатор и тег из реестра Ollama. Загрузка весов начнётся после нажатия «Запустить»."
                    rules={[{ required: true, message: 'Укажите модель и тег' }, { pattern: ollamaModelPattern, message: 'Формат: qwen3:4b или автор/модель:тег' }]}>
                    <Input placeholder="qwen3:4b" />
                </Form.Item>
                {capability === 'embedding' && <Form.Item name="dimension" label="Размерность эмбеддинга" extra="Если известна. Смена модели не перестраивает существующие индексы."
                    rules={[{ type: 'integer', min: 1, max: 16384, message: 'Целое число от 1 до 16384' }]}>
                    <InputNumber min={1} max={16384} precision={0} style={{ width: '100%' }} placeholder="Например, 2560" />
                </Form.Item>}
            </>}
            <Space className="model-catalog__form-actions"><Button disabled={busy} onClick={onClose}>Отмена</Button><Button type="primary" htmlType="submit" loading={busy}>Сохранить</Button></Space>
        </Form>
    </Modal>;
}
