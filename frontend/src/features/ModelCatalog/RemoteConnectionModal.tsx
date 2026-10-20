import { Alert, Button, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Spin, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { modelCatalogApi } from './api';
import type { ICatalogModel, IRemoteConnection, IRemoteConnectionInput } from './types';
import { isRemoteApiUrl } from './remoteModelForm';

interface IProps { model: ICatalogModel; hint?: { baseUrl: string; hasKey: boolean }; onClose: () => void; onSaved: () => Promise<void>; }
type Values = Omit<IRemoteConnectionInput, 'expectedRevision' | 'expectedModelRevision'>;

/** URL и write-only ключ находятся в приватной настройке площадки, вне карточки и source envelope. */
export function RemoteConnectionModal({ model, hint, onClose, onSaved }: IProps): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const [form] = Form.useForm<Values>();
    const credential = Form.useWatch('credential', form) ?? 'stored';
    const [view, setView] = useState<IRemoteConnection>();
    const [current, setCurrent] = useState(model);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [pendingCheck, setPendingCheck] = useState(false);
    const lock = useRef(false), mounted = useRef(false);
    const read = async (): Promise<void> => {
        const owns = captureOwner(); setLoading(true); setError('');
        try {
            const result = await modelCatalogApi.connection(model.id);
            if (!owns() || !mounted.current) return;
            setView(result);
            form.setFieldsValue({ baseUrl: result.baseUrl || hint?.baseUrl, requestDimensions: result.requestDimensions,
                credential: result.revision ? result.credential : result.canStoreKey ? 'stored' : 'environment', credentialEnv: result.credentialEnv ?? undefined });
        } catch (cause) { if (owns() && mounted.current) setError(errorMessage(cause, 'Не удалось прочитать настройки подключения.')); }
        finally { if (owns() && mounted.current) setLoading(false); }
    };
    useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; }; }, [model.id]);
    const submit = async (values: Values): Promise<void> => {
        const owns = captureOwner(); if (!view || !owns() || lock.current) return;
        const active = () => owns() && mounted.current;
        lock.current = true; setBusy(true); setError('');
        let saved = pendingCheck;
        try {
            let selected = current;
            if (!saved) {
                const result = await modelCatalogApi.configure(model.id, { expectedRevision: view.revision, expectedModelRevision: current.revision,
                    baseUrl: values.baseUrl.trim(), requestDimensions: !!values.requestDimensions, credential: values.credential,
                    ...(values.credential === 'stored' && values.apiKey ? { apiKey: values.apiKey } : {}),
                    ...(values.credential === 'environment' ? { credentialEnv: values.credentialEnv?.trim() } : {}) });
                if (!active()) return;
                setView(result); form.setFieldValue('apiKey', undefined);
                selected = await modelCatalogApi.get(model.id);
                if (!active()) return;
                setCurrent(selected); setPendingCheck(true); saved = true;
            }
            await modelCatalogApi.operate(selected, 'check');
            if (!active()) return;
            await onSaved(); if (active()) onClose();
        } catch (cause) {
            if (active()) setError((saved ? 'Настройки сохранены. Проверка не запущена: ' : '') + errorMessage(cause, 'Не удалось подключить модель.'));
        } finally { lock.current = false; if (active()) setBusy(false); }
    };
    const revoke = async (): Promise<void> => {
        const owns = captureOwner(); if (!view || !owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            await modelCatalogApi.revoke(current, view.revision);
            if (!owns() || !mounted.current) return;
            await onSaved(); if (owns() && mounted.current) onClose();
        } catch (cause) {
            if (owns() && mounted.current) {
                const projects = (cause as { response?: { data?: { projects?: Array<{ name: string }> } } })?.response?.data?.projects;
                setError(errorMessage(cause, 'Не удалось удалить подключение.') + (projects?.length ? ' Проекты: ' + projects.map(project => project.name).join(', ') + '.' : ''));
            }
        } finally { lock.current = false; if (owns() && mounted.current) setBusy(false); }
    };
    return <Modal open centered className="model-details" title={`Подключение «${model.name}»`} width={620} footer={null}
        onCancel={() => { if (!lock.current) onClose(); }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
        {error && <Alert type="error" showIcon message={error} className="model-catalog__notice" action={!view ? <Button onClick={() => { void read(); }}>Повторить</Button> : undefined} />}
        {loading ? <div role="status" aria-live="polite"><Spin tip="Читаем настройки…" /></div> : view && <Form form={form} layout="vertical" disabled={busy}
            onValuesChange={() => setPendingCheck(false)} onFinish={values => { void submit(values); }}>
            <Typography.Paragraph type="secondary">Нейроцентр проверит модель и сохранит её подключение. Компьютеры проекта обращаются к ней через API Gateway.</Typography.Paragraph>
            {hint?.hasKey && !view.revision && <Alert type="info" showIcon message="Ключ OpenCode остался на компьютере" description="Введите API-ключ для Нейроцентра или выберите ключ из окружения сервера." className="model-catalog__notice" />}
            <Form.Item name="baseUrl" label="Адрес API" extra={model.runtime === 'remote-openai' ? 'Базовый адрес OpenAI API с префиксом, например https://provider.example/v1.' : 'Адрес Ollama без /api/embed.'}
                rules={[{ required: true, whitespace: true, message: 'Укажите адрес API' }, { validator: (_rule, value) => !value || isRemoteApiUrl(value) ? Promise.resolve() : Promise.reject(new Error('Укажите HTTP(S) адрес без ключа, пароля и параметров')) }]}><Input autoComplete="off" placeholder={model.runtime === 'remote-openai' ? 'https://provider.example/v1' : 'http://models.internal:11434'} /></Form.Item>
            {model.capability === 'embedding' && <Form.Item name="requestDimensions" valuePropName="checked"><Checkbox>Запрашивать {model.dimension || 'указанную'} размерность у провайдера</Checkbox></Form.Item>}
            <Form.Item name="credential" label="Авторизация" rules={[{ required: true }]}><Select options={[{ value: 'stored', label: 'API-ключ' }, { value: 'environment', label: 'Ключ из окружения сервера' }, { value: 'none', label: 'API без ключа' }]} /></Form.Item>
            {credential === 'stored' && <>
                {!view.canStoreKey && <Alert type="warning" showIcon message="Хранилище ключей не настроено" description="Администратору сервера нужно задать NEUROCENTER_MODEL_CREDENTIAL_KEY. Можно использовать ключ из окружения сервера." className="model-catalog__notice" />}
                <Form.Item name="apiKey" label="API-ключ" extra={view.hasKey ? 'Ключ уже сохранён. Оставьте поле пустым, чтобы сохранить его.' : 'Значение сохраняется зашифрованным и больше не показывается.'}
                    rules={[{ required: !view.hasKey, message: 'Введите API-ключ' }]}><Input.Password autoComplete="new-password" placeholder={view.hasKey ? 'Сохранённый ключ скрыт' : 'Введите ключ'} /></Form.Item>
            </>}
            {credential === 'environment' && <Form.Item name="credentialEnv" label="Имя переменной окружения" extra="В форме задаётся имя, значение остаётся на сервере." rules={[{ required: true, message: 'Укажите имя переменной' }, { pattern: /^NEUROCENTER_REMOTE_MODEL_[A-Z0-9_]{1,100}$/, message: 'Имя должно начинаться с NEUROCENTER_REMOTE_MODEL_' }]}><Input placeholder="NEUROCENTER_REMOTE_MODEL_PROVIDER" autoComplete="off" /></Form.Item>}
            <Space wrap className="model-catalog__form-actions">
                {view.revision > 0 && view.baseUrl && <Popconfirm title="Отозвать все версии этого подключения?" onConfirm={() => { void revoke(); }} okText="Отозвать" cancelText="Отмена"><Button danger disabled={busy}>Удалить подключение</Button></Popconfirm>}
                <Button disabled={busy} onClick={onClose}>Отмена</Button><Button type="primary" htmlType="submit" loading={busy} disabled={credential === 'stored' && !view.canStoreKey}>{pendingCheck ? 'Запустить проверку' : 'Сохранить и подключить'}</Button>
            </Space>
        </Form>}
    </Modal>;
}
