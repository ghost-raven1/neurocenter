import { Alert, Button, Form, Input, message, Modal, Select, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { FC, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDate } from "../../../common/utils/format";
import bffApi from "../../../core/api/bff";
import {useSectionUpdates} from '../../../core/socket/useSectionUpdates';
import type { IProjectDetail, IProjectMember, IProjectMemberAdd } from "../../../core/api/interfaces";
import { useSelector } from "react-redux";
import type { RootState } from "../../../store";
import { projectRoleLevel, isMainAdminRole } from "../../../features/UserBlock/roles";
import { useAuthRequestOwner } from '../../../features/UserBlock/useAuthRequestOwner';
import { createProjectMembersController, initialProjectMembersState } from '../projectMembersController';
const { Paragraph } = Typography;
const MEMBER_ROLE_OPTIONS = ['Админ проекта', 'Разработчик', 'Наблюдатель'];

/** Вкладка проекта вынесена в самостоятельный компонент. */
const MembersTab: FC<{ project: IProjectDetail }> = ({ project }) => {
    const { captureOwner } = useAuthRequestOwner();
    const user=useSelector((state:RootState)=>state.userBlock.user);
    const canManage=projectRoleLevel(user,project.id)>=3;
    const main=isMainAdminRole(user?.activeRole);
    const roleOptions=MEMBER_ROLE_OPTIONS.filter(role=>main || role!=="Админ проекта");
    const [{ members, loading, loadError }, setMemberState] = useState(initialProjectMembersState);
    const [ addOpen, setAddOpen ] = useState(false);
    const [ saving, setSaving ] = useState(false);
    const savingRef = useRef(false);
    const confirmations = useRef(new Set<{ destroy: () => void }>());
    const [emailError, setEmailError] = useState('');
    const [ login, setLogin ] = useState('');
    const [ name, setName ] = useState('');
    const [ role, setRole ] = useState<string>(MEMBER_ROLE_OPTIONS[1]);

    const reader = useMemo(() => createProjectMembersController({
        isOwnerCurrent: () => captureOwner()(),
        read: () => bffApi.listProjectMembers(project.id),
        onChange: setMemberState,
    }), [project.id, captureOwner]);
    const load = useCallback(() => { void reader.refresh(); }, [reader]);
    useSectionUpdates(['access','projects'],load);

    useEffect(() => {
        reader.activate();
        load();
        return () => { reader.dispose(); };
    }, [ load, reader ]);

    useEffect(() => {
        setAddOpen(false); setSaving(false); savingRef.current = false;
        setLogin(''); setName(''); setRole(MEMBER_ROLE_OPTIONS[1]); setEmailError('');
        const dialogs = confirmations.current;
        return () => { dialogs.forEach(dialog => dialog.destroy()); dialogs.clear(); };
    }, [project.id, captureOwner]);

    const errMsg = useCallback((err: unknown): string => {
        const e = err as { response?: { data?: { message?: string } } };

        return e?.response?.data?.message ?? 'Не удалось выполнить операцию';
    }, []);

    const submitAdd = useCallback(async () => {
        if (savingRef.current || !canManage) { return; }
        const isCurrent = captureOwner();
        if (!isCurrent()) { return; }
        const principalName = login.trim();

        if (!/^[^\s@]+@[^\s@]+$/.test(principalName) || principalName.length > 254) {
            setEmailError('Укажите корректную электронную почту');
            return;
        }
        setEmailError(''); savingRef.current = true;
        setSaving(true);
        try {
            const addPayload: IProjectMemberAdd = {
                principalName,
                displayName: name.trim() || principalName,
                role,
            };

            await bffApi.addProjectMember(project.id, addPayload);
            if (!isCurrent()) { return; }
            message.success('Сотрудник добавлен');
            setAddOpen(false);
            setLogin('');
            setName('');
            setRole(MEMBER_ROLE_OPTIONS[1]);
            load();
        } catch (err) {
            if (isCurrent()) { message.error(errMsg(err)); }
        } finally {
            if (isCurrent()) { savingRef.current = false; setSaving(false); }
        }
    }, [ login, name, role, project.id, load, errMsg, canManage, captureOwner ]);

    const changeRole = useCallback(async (userId: string, nextRole: string) => {
        const isCurrent = captureOwner();
        if (!isCurrent() || !canManage) { return; }
        try {
            await bffApi.updateProjectMember(project.id, userId, { role: nextRole, expectedRole: members?.find(member=>member.userId===userId)?.role });
            if (!isCurrent()) { return; }
            message.success('Роль обновлена');
            load();
        } catch (err) {
            if (isCurrent()) { message.error(errMsg(err)); }
        }
    }, [ project.id, load, errMsg, members, canManage, captureOwner ]);

    const removeMember = useCallback((member: IProjectMember): void => {
        const isCurrent = captureOwner();
        if (!isCurrent() || !canManage) { return; }
        const confirmation = Modal.confirm({
            title: `Удалить «${member.principalName}» из проекта?`,
            content: 'Сотрудник потеряет доступ к проекту.',
            okText: 'Удалить',
            okButtonProps: { danger: true },
            cancelText: 'Отмена',
            afterClose: () => { confirmations.current.delete(confirmation); },
            onOk: async () => {
                if (!isCurrent()) { return; }
                try {
                    await bffApi.removeProjectMember(project.id, member.userId, member.role);
                    if (!isCurrent()) { return; }
                    message.success('Сотрудник удалён');
                    load();
                } catch (err) {
                    if (isCurrent()) { message.error(errMsg(err)); }
                }
            },
        });
        confirmations.current.add(confirmation);
    }, [ project.id, load, errMsg, canManage, captureOwner ]);

    const columns: ColumnsType<IProjectMember> = [
        { title: 'Электронная почта', dataIndex: 'principalName', render: (v: string) => <b>{v}</b> },
        { title: 'Имя', dataIndex: 'displayName' },
        {
            title: 'Роль',
            dataIndex: 'role',
            render: (v: string, r: IProjectMember) => !canManage || (!main && v==="Админ проекта") ? v : (
                <Select
                    aria-label={`Роль ${r.principalName}`}
                    size="small"
                    value={v}
                    options={roleOptions.map((opt) => ({ value: opt, label: opt }))}
                    onChange={(next: string) => changeRole(r.userId, next)}
                    style={{ width: 150 }}
                />
            ),
        },
        { title: 'Добавлен', dataIndex: 'addedAt', render: (v: string) => formatDate(v) },
        {
            title: 'Действия',
            key: 'actions',
            width: 110,
            render: (_v: unknown, r: IProjectMember) => canManage && (main || r.role!=="Админ проекта") ? (
                <Button danger size="small" onClick={() => removeMember(r)}>
                    Удалить
                </Button>
            ) : null,
        },
    ];

    return (
        <div>
            <Space style={{ marginBottom: 16 }} wrap>
                {canManage && <Button type="primary" onClick={() => setAddOpen(true)}>
                    Добавить сотрудника
                </Button>}
                <Button type="link" onClick={load}>
                    Обновить
                </Button>
            </Space>
            <Paragraph type="secondary">
                Сотрудники проекта и их роли: добавьте нового работника, измените роль или удалите.
            </Paragraph>
            {loadError && <Alert type="error" showIcon message="Не удалось загрузить сотрудников" style={{marginBottom:16}} action={<Button size="small" onClick={load}>Повторить</Button>} />}
            <Table
                rowKey="userId"
                columns={columns}
                dataSource={members ?? []}
                loading={loading}
                size="small"
                scroll={{x: 780}}
                pagination={{ pageSize: 20 }}
            />
            <Modal
                title="Добавить сотрудника в проект"
                open={addOpen && canManage}
                onOk={submitAdd}
                confirmLoading={saving}
                onCancel={() => {if (!savingRef.current) {setAddOpen(false);}}}
                closable={!saving} keyboard={!saving} maskClosable={!saving} cancelButtonProps={{disabled:saving}}
                okText="Добавить"
                cancelText="Отмена"
            >
                <Form layout="vertical" style={{ marginTop: 12 }}>
                    <Form.Item label="Электронная почта" htmlFor="member-email" required validateStatus={emailError?'error':undefined} help={emailError || undefined}>
                        <Input id="member-email" value={login} disabled={saving} onChange={(e) => {setLogin(e.target.value);setEmailError('');}} type="email" placeholder="name@example.test" maxLength={254} />
                    </Form.Item>
                    <Form.Item label="Имя (необязательно)" htmlFor="member-name">
                        <Input id="member-name" value={name} disabled={saving} maxLength={128} onChange={(e) => setName(e.target.value)} placeholder="Иван Иванов" />
                    </Form.Item>
                    <Form.Item label="Роль">
                        <Select
                            aria-label="Роль нового сотрудника" disabled={saving}
                            value={role}
                            options={roleOptions.map((opt) => ({ value: opt, label: opt }))}
                            onChange={(next: string) => setRole(next)}
                            style={{ width: '100%' }}
                        />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
};

export default MembersTab;
