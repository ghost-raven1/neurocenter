import { Alert, Button, Checkbox, Form, Input, Modal, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { isAxiosError } from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import base from '../../core/api/base';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAppDispatch } from '../../core/hooks';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { authInit } from '../../features/UserBlock/redux/actions';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import type { RootState } from '../../store';
import { accessEmail, platformUserPayload } from './accessHelpers';
import type { IPlatformUser, IPlatformUserValues } from './accessHelpers';

/** Системные учётные записи по почте; проектные роли назначаются на соседней вкладке. */
export default function PlatformUsers(): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const dispatch = useAppDispatch();
    const currentUser = useSelector((state: RootState) => state.userBlock.user);
    const [users, setUsers] = useState<IPlatformUser[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [saveError, setSaveError] = useState('');
    const [conflict, setConflict] = useState(false);
    const [previousDraft, setPreviousDraft] = useState<IPlatformUserValues | null>(null);
    const [showPrevious, setShowPrevious] = useState(false);
    const [editing, setEditing] = useState<IPlatformUser | 'new' | null>(null);
    const [search, setSearch] = useState('');
    const [form] = Form.useForm<IPlatformUserValues>();
    const requestRef = useRef(0);
    const submittingRef = useRef(false);

    const load = useCallback(async (): Promise<void> => {
        const isCurrent=captureOwner(); if(!isCurrent()){return;}
        const request = ++requestRef.current;
        setLoading(true); setLoadError('');
        try {
            const result = await base.get<IPlatformUser[]>('/api/platform/users');
            if (isCurrent() && request === requestRef.current) { setUsers(result.data); }
        } catch (error: unknown) {
            if (isCurrent() && request === requestRef.current) { setLoadError(errorMessage(error, 'Не удалось загрузить пользователей. Проверьте соединение и повторите попытку.')); }
        } finally { if (isCurrent() && request === requestRef.current) { setLoading(false); } }
    }, [captureOwner]);
    useEffect(() => { void load(); return () => { requestRef.current += 1; }; }, [load]);
    useSectionUpdates(['access'], () => { void load(); });

    const open = (user: IPlatformUser | 'new'): void => {
        setEditing(user); setSaveError(''); setConflict(false); setPreviousDraft(null); setShowPrevious(false); form.resetFields();
        form.setFieldsValue(user === 'new' ? { email: '', displayName: '', enabled: true, isMainAdmin: false } : user);
    };
    const lastMain = Boolean(editing && editing !== 'new' && editing.isMainAdmin && editing.enabled && users?.filter(user => user.enabled && user.isMainAdmin).length === 1);
    const save = async (values: IPlatformUserValues): Promise<void> => {
        const isCurrent=captureOwner();
        if (!isCurrent() || !editing || submittingRef.current || !users || conflict) { return; }
        submittingRef.current = true; setSaving(true); setSaveError('');
        try {
            const payload = platformUserPayload(values, editing === 'new', users, editing === 'new' ? undefined : editing);
            await base.post('/api/platform/users', payload);
            if (!isCurrent()) { return; }
            setEditing(null);
            message.success(editing === 'new' ? 'Пользователь добавлен. Назначьте ему доступ к проектам.' : 'Настройки пользователя сохранены');
            if (payload.email === currentUser?.email?.toLowerCase() && (!payload.enabled || !payload.isMainAdmin)) { void dispatch(authInit()); }
            else { void load(); }
        } catch (error: unknown) {
            if (!isCurrent()) { return; }
            setSaveError(errorMessage(error, 'Не удалось сохранить пользователя. Введённые данные остались в форме.'));
            setConflict(editing !== 'new' && isAxiosError(error) && error.response?.status === 409);
        }
        finally { if(isCurrent()){submittingRef.current = false; setSaving(false);} }
    };

    const refreshEditing = async (): Promise<void> => {
        const isCurrent=captureOwner();
        if (!isCurrent() || !editing || editing === 'new' || submittingRef.current) { return; }
        submittingRef.current = true; setSaving(true);
        const draft = form.getFieldsValue(true);
        try {
            const result = await base.get<IPlatformUser[]>('/api/platform/users');
            if (!isCurrent()) { return; }
            const fresh = result.data.find(user => user.email === editing.email);
            if (!fresh) { throw new Error('Учётная запись больше недоступна. Ваши правки остались в форме.'); }
            setUsers(result.data); setEditing(fresh); setPreviousDraft(draft); setShowPrevious(false);
            form.setFieldsValue(fresh); setConflict(false); setSaveError('');
        } catch (error: unknown) { if(isCurrent()){setSaveError(errorMessage(error, 'Не удалось загрузить актуальные настройки. Ваши правки остались в форме.'));} }
        finally { if(isCurrent()){submittingRef.current = false; setSaving(false);} }
    };

    const filtered = (users ?? []).filter(user => (user.email + ' ' + user.displayName).toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')));
    const columns: ColumnsType<IPlatformUser> = [
        { title: 'Пользователь', dataIndex: 'email', render: (_, user) => <Space direction="vertical" size={2}><Typography.Text strong>{user.displayName || user.email}</Typography.Text>{user.displayName && <Typography.Text type="secondary">{user.email}</Typography.Text>}</Space> },
        { title: 'Системная роль', render: (_, user) => <Tag color={user.isMainAdmin ? 'purple' : undefined}>{user.isMainAdmin ? 'Главный админ' : 'Роли в проектах'}</Tag> },
        { title: 'Состояние', render: (_, user) => <Tag color={user.enabled ? 'green' : undefined}>{user.enabled ? 'Активен' : 'Отключён'}</Tag> },
        { title: 'Действия', width: 120, render: (_, user) => <Button size="small" aria-label={'Настроить пользователя ' + user.email} onClick={() => open(user)}>Настроить</Button> },
    ];
    return <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Alert showIcon type="info" message="Добавьте сотрудника по почте, затем назначьте роли в нужных проектах." description="Письмо-приглашение автоматически не отправляется. Почта должна совпадать с адресом сотрудника при входе." />
        {loadError && <Alert showIcon type="error" role="alert" message="Список пользователей не обновлён" description={loadError} action={<Button onClick={() => void load()} loading={loading}>Повторить</Button>} />}
        <div className="access-page__toolbar"><Input.Search placeholder="Почта или имя сотрудника" aria-label="Найти пользователя" allowClear value={search} onChange={event => setSearch(event.target.value)} /><Space wrap><Button onClick={() => void load()} loading={loading}>Обновить</Button><Button type="primary" disabled={!users || loading || Boolean(loadError)} onClick={() => open('new')}>Добавить пользователя</Button></Space></div>
        <Table<IPlatformUser> rowKey="email" loading={loading || users === null && !loadError} dataSource={filtered} scroll={{ x: 660 }} columns={columns} pagination={{ pageSize: 20, hideOnSinglePage: true, showTotal: total => 'Пользователей: ' + total }} locale={{ emptyText: loadError ? 'Повторите загрузку списка пользователей' : search.trim() ? 'Пользователи с такой почтой или именем не найдены' : 'Пользователи ещё не добавлены' }} />
        <Modal
            open={editing !== null} title={editing === 'new' ? 'Добавить пользователя' : 'Настройки пользователя'} width={560} className="platform-user-modal"
            okText={editing === 'new' ? 'Добавить пользователя' : 'Сохранить изменения'} cancelText="Отмена"
            confirmLoading={saving} okButtonProps={{ form: 'platform-user-form', htmlType: 'submit', disabled: conflict }} cancelButtonProps={{ disabled: saving }}
            maskClosable={false} closable={!saving} keyboard={!saving}
            onCancel={() => { if (!submittingRef.current) { setEditing(null); } }}
        >
            {saveError && <Alert type="error" showIcon role="alert" message="Изменения не сохранены" description={<><div>{saveError}</div>{conflict && <Button onClick={() => void refreshEditing()} disabled={saving} style={{ marginTop: 12 }}>Загрузить актуальные настройки</Button>}</>} className="access-page__form-error" />}
            {previousDraft && <Alert type="info" showIcon message="Предыдущий черновик сохранён в этом окне" description={<><Typography.Paragraph>Ниже открыты актуальные настройки. Сравните их со своими правками перед сохранением.</Typography.Paragraph><Button size="small" onClick={() => setShowPrevious(value => !value)}>{showPrevious ? 'Скрыть черновик' : 'Показать черновик'}</Button>{showPrevious && <Input.TextArea value={JSON.stringify(previousDraft, null, 2)} aria-label="Предыдущий черновик настроек пользователя" readOnly autoSize={{ minRows: 5, maxRows: 9 }} style={{ marginTop: 12 }} />}</>} className="access-page__form-error" />}
            <Form<IPlatformUserValues> id="platform-user-form" form={form} layout="vertical" disabled={saving} noValidate onFinish={values => void save(values)}>
                <Form.Item label="Электронная почта" name="email" validateFirst rules={[{ required: true, whitespace: true, message: 'Укажите почту' }, { validator: (_, value: string) => { try { accessEmail(value ?? ''); return Promise.resolve(); } catch (error: unknown) { return Promise.reject(error); } } }]} extra={editing === 'new' ? 'Используйте рабочую почту сотрудника.' : 'Адрес учётной записи сохраняется. Для другой почты добавьте нового пользователя.'}>
                    <Input type="email" disabled={editing !== 'new' || saving} maxLength={254} autoComplete="email" placeholder="name@example.test" />
                </Form.Item>
                <Form.Item label="Имя" name="displayName" rules={[{ max: 128, message: 'До 128 символов' }, { pattern: /^[^\x00-\x1f\x7f]*$/, message: 'Имя не должно содержать управляющие символы' }]}><Input placeholder="Имя сотрудника" maxLength={128} autoComplete="name" /></Form.Item>
                <Form.Item name="isMainAdmin" valuePropName="checked"><Checkbox disabled={saving || lastMain}>Главный админ — управление всей системой</Checkbox></Form.Item>
                <Form.Item name="enabled" valuePropName="checked"><Checkbox disabled={saving || lastMain}>Учётная запись активна</Checkbox></Form.Item>
                {lastMain ? <Alert type="info" showIcon message="Это последний активный главный администратор" description="Сначала назначьте другого главного администратора. После этого можно отключить учётную запись или изменить её роль." /> : <Typography.Paragraph type="secondary">Отключение учётной записи блокирует следующие запросы сотрудника. Роли в проектах сохраняются.</Typography.Paragraph>}
                <Typography.Paragraph type="secondary">Главный админ управляет пользователями и всеми проектами. Остальным сотрудникам назначьте роли на вкладке «Доступ к проектам».</Typography.Paragraph>
            </Form>
        </Modal>
    </Space>;
}
