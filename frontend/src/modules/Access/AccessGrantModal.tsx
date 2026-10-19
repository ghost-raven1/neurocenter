import { Alert, Button, Checkbox, Form, Input, Modal, Select, Space, Spin, Tag, Typography, message } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import bffApi from '../../core/api/bff';
import type { IAccessProjectRef, IAccessUserRow, IProjectSummary } from '../../core/api/interfaces';
import { errorMessage } from '../../common/utils/errorMessage';
import { isMainAdminRole, projectRoleLevel } from '../../features/UserBlock/roles';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import type { RootState } from '../../store';
import { useSectionUpdates } from '../../core/socket/useSectionUpdates';
import { accessEmail, applyGrantChange, grantChanges, grantMap, PROJECT_ROLE_OPTIONS, sameManagedGrants } from './accessHelpers';
import type { IGrantChange, TGrantMap } from './accessHelpers';

interface IProps { open: boolean; principalName: string; onClose: () => void; onSaved: (email: string, complete: boolean) => void; }

async function allProjects(): Promise<IProjectSummary[]> {
    const projects: IProjectSummary[] = [];
    for (let page = 1; ; page += 1) {
        const result = await bffApi.listProjects({ page, size: 100, query: '' });
        projects.push(...result.items);
        if (result.page * result.size >= result.total) { return projects; }
        if (!result.items.length) { throw new Error('Список проектов изменился во время загрузки. Повторите попытку.'); }
    }
}

/** Выдаёт проектные роли по почте; повторная попытка сохраняет только неуспешные изменения. */
export default function AccessGrantModal({ open, principalName, onClose, onSaved }: IProps): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const user = useSelector((state: RootState) => state.userBlock.user);
    const main = isMainAdminRole(user?.activeRole);
    const userRef = useRef(user);
    userRef.current = user;
    const [email, setEmail] = useState(principalName);
    const [projects, setProjects] = useState<IProjectSummary[]>([]);
    const [knownUsers, setKnownUsers] = useState<IAccessUserRow[]>([]);
    const [initial, setInitial] = useState<IAccessProjectRef[]>([]);
    const [grants, setGrants] = useState<TGrantMap>({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [saveError, setSaveError] = useState('');
    const [emailError, setEmailError] = useState('');
    const [failedProjects, setFailedProjects] = useState<string[]>([]);
    const [staleRefs, setStaleRefs] = useState<IAccessProjectRef[] | null>(null);
    const [previousChoice, setPreviousChoice] = useState<string[]>([]);
    const [search, setSearch] = useState('');
    const [reloadCount, setReloadCount] = useState(0);
    const submittingRef = useRef(false);
    const validationRequestRef = useRef(0);
    const emailRef = useRef(email);
    const initialRef = useRef(initial);
    emailRef.current = email;
    initialRef.current = initial;

    useEffect(() => {
        if (!open) { return; }
        let cancelled = false;
        const isCurrent = captureOwner();
        validationRequestRef.current += 1;
        setEmail(principalName); setGrants({}); setInitial([]); setProjects([]); setKnownUsers([]); setLoading(true);
        setSaveError(''); setLoadError(''); setEmailError(''); setFailedProjects([]); setStaleRefs(null); setPreviousChoice([]); setSearch('');
        Promise.all([allProjects(), bffApi.getAccessUsers()]).then(([result, access]) => {
            if (cancelled || !isCurrent()) { return; }
            const managed = result.filter(project => projectRoleLevel(userRef.current, project.id) >= 3);
            const refs = access.users.find(row => row.principalName.toLowerCase() === principalName.trim().toLowerCase())?.accesses ?? [];
            setProjects(managed); setKnownUsers(access.users); setInitial(refs); setGrants(grantMap(refs));
        }).catch((error: unknown) => { if (!cancelled && isCurrent()) { setLoadError(errorMessage(error, 'Не удалось загрузить проекты и назначения. Проверьте соединение.')); } })
            .finally(() => { if (!cancelled && isCurrent()) { setLoading(false); } });
        return () => { cancelled = true; validationRequestRef.current += 1; };
    }, [open, principalName, reloadCount, captureOwner]);

    /** Фоновое событие лишь сравнивает копии; выбор и исходные версии остаются нетронутыми. */
    const checkLiveChanges = async (): Promise<void> => {
        let target: string;
        try { target = accessEmail(email); } catch { return; }
        const snapshot = initial;
        const request = ++validationRequestRef.current;
        const isCurrent = captureOwner();
        try {
            const result = await bffApi.getAccessUsers();
            if (!isCurrent() || request !== validationRequestRef.current || submittingRef.current || emailRef.current.trim().toLowerCase() !== target || initialRef.current !== snapshot) { return; }
            const refs = result.users.find(row => row.principalName.toLowerCase() === target)?.accesses ?? [];
            setKnownUsers(result.users);
            if (!sameManagedGrants(snapshot, refs, new Set(projects.map(project => project.id)))) {
                setStaleRefs(refs);
                setSaveError('Назначения изменились на сервере. Ваш выбор и исходная копия сохранены. Загрузите актуальные назначения перед сохранением.');
            }
        } catch (error: unknown) {
            if (isCurrent() && request === validationRequestRef.current && !submittingRef.current) { setSaveError(errorMessage(error, 'Не удалось проверить свежие назначения. Ваш выбор остался в форме.')); }
        }
    };
    useSectionUpdates(['access', 'projects'], () => { void checkLiveChanges(); }, open && !loading && !saving && !loadError);

    const planned = useMemo((): IGrantChange[] => {
        try { return grantChanges(projects, initial, grants, accessEmail(email), main); } catch { return []; }
    }, [projects, initial, grants, email, main]);
    const checkedCount = projects.filter(project => grants[project.id]?.checked).length;
    const visibleProjects = projects.filter(project => `${project.name} ${project.id}`.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')));

    const changeEmail = (value: string): void => {
        validationRequestRef.current += 1;
        setEmail(value); setEmailError(''); setSaveError(''); setFailedProjects([]); setStaleRefs(null); setPreviousChoice([]);
        const refs = knownUsers.find(row => row.principalName.toLowerCase() === value.trim().toLowerCase())?.accesses ?? [];
        setInitial(refs); setGrants(grantMap(refs));
    };

    const save = async (): Promise<void> => {
        if (submittingRef.current || loading || loadError || staleRefs) { return; }
        const isCurrent = captureOwner();
        if (!isCurrent()) { return; }
        let normalized: string;
        let changes: IGrantChange[];
        try { normalized = accessEmail(email); changes = grantChanges(projects, initial, grants, normalized, main); }
        catch (error: unknown) { setEmailError(errorMessage(error, 'Проверьте почту и роли.')); return; }
        if (!changes.length) { return; }
        if (changes.some(change => projectRoleLevel(userRef.current, change.projectId) < 3)) { setSaveError('Права на управление проектами изменились. Черновик сохранён; обновите страницу доступа после проверки своих назначений.'); return; }
        submittingRef.current = true; setSaving(true); setSaveError(''); setFailedProjects([]);
        try {
            const current = await bffApi.getAccessUsers();
            if (!isCurrent()) { return; }
            const refs = current.users.find(row => row.principalName.toLowerCase() === normalized)?.accesses ?? [];
            if (!sameManagedGrants(initial, refs, new Set(projects.map(project => project.id)))) {
                setStaleRefs(refs); setSaveError('Назначения этого пользователя изменились, пока окно было открыто. Ваш выбор сохранён. Загрузите актуальные назначения перед повторной отправкой.'); return;
            }
            let nextInitial = initial;
            const failures: string[] = [];
            for (const change of changes) {
                if (!isCurrent()) { return; }
                try {
                    if (!change.previousRole && change.desiredRole) { await bffApi.addProjectMember(change.projectId, { principalName: normalized, role: change.desiredRole }); }
                    else if (change.desiredRole) { await bffApi.updateProjectMember(change.projectId, change.userId, { role: change.desiredRole, expectedRole: change.previousRole ?? undefined }); }
                    else { await bffApi.removeProjectMember(change.projectId, change.userId, change.previousRole ?? undefined); }
                    nextInitial = applyGrantChange(nextInitial, change);
                } catch (error: unknown) { failures.push(`${change.projectName}: ${errorMessage(error, 'Не удалось изменить доступ. Проверьте соединение и полномочия.')}`); }
            }
            if (!isCurrent()) { return; }
            setInitial(nextInitial);
            setKnownUsers(rows => [...rows.filter(row => row.principalName.toLowerCase() !== normalized), { principalName: normalized, displayName: normalized, accesses: nextInitial }]);
            onSaved(normalized, failures.length === 0);
            if (failures.length) { setFailedProjects(failures); setSaveError(`Сохранено ${changes.length - failures.length} из ${changes.length} изменений. Повторная попытка применит оставшиеся.`); }
            else { message.success('Доступ к проектам сохранён'); onClose(); }
        } catch (error: unknown) { if (isCurrent()) { setSaveError(errorMessage(error, 'Не удалось проверить актуальные назначения. Ваш выбор остался в форме.')); } }
        finally { submittingRef.current = false; if (isCurrent()) { setSaving(false); } }
    };

    const reloadAssignments = (): void => {
        setPreviousChoice(planned.map(change => `${change.projectName}: ${change.desiredRole ?? 'отозвать доступ'}`));
        setInitial(staleRefs ?? []); setGrants(grantMap(staleRefs ?? [])); setStaleRefs(null); setSaveError('');
    };

    return <Modal
        open={open} title={principalName ? `Доступ к проектам — ${principalName}` : 'Выдать доступ к проектам'}
        width={700} className="access-grant-modal" destroyOnClose maskClosable={false} closable={!saving} keyboard={!saving}
        onCancel={() => { if (!submittingRef.current) { onClose(); } }} onOk={() => void save()}
        okText={`Сохранить изменения${planned.length ? ` (${planned.length})` : ''}`} cancelText="Отмена" confirmLoading={saving}
        okButtonProps={{ disabled: loading || Boolean(loadError) || Boolean(staleRefs) || !planned.length || planned.some(change => projectRoleLevel(user, change.projectId) < 3) }} cancelButtonProps={{ disabled: saving }}
    >
        <Typography.Paragraph type="secondary">Почта должна совпадать с адресом сотрудника при входе. Здесь показаны проекты, которыми вы управляете.</Typography.Paragraph>
        {loadError && <Alert type="error" showIcon role="alert" message="Назначения не загружены" description={loadError} action={<Button onClick={() => setReloadCount(count => count + 1)}>Повторить</Button>} />}
        {saveError && <Alert type="error" showIcon role="alert" message={saveError} description={<>
            {failedProjects.length > 0 && <ul>{failedProjects.map(item => <li key={item}>{item}</li>)}</ul>}
            {staleRefs && <Button onClick={reloadAssignments}>Загрузить актуальные назначения</Button>}
        </>} />}
        {previousChoice.length > 0 && <Alert type="info" showIcon message="Предыдущий выбор сохранён для сравнения" description={<ul>{previousChoice.map(item => <li key={item}>{item}</li>)}</ul>} />}
        <Spin spinning={loading} tip="Загружаем проекты и назначения…">
            <Form layout="vertical" disabled={saving || loading || Boolean(loadError)}>
                <Form.Item label="Электронная почта" htmlFor="access-grant-email" validateStatus={emailError ? 'error' : undefined} help={emailError || (principalName ? 'Для другого сотрудника откройте выдачу нового доступа.' : 'При смене почты загружаются назначения выбранного сотрудника.')}>
                    <Input id="access-grant-email" value={email} type="email" autoComplete="email" placeholder="name@example.test" disabled={Boolean(principalName) || saving || loading || Boolean(loadError)} onChange={event => changeEmail(event.target.value)} onBlur={() => { if (email.trim()) { try { setEmail(accessEmail(email)); } catch (error: unknown) { setEmailError(errorMessage(error, 'Проверьте почту.')); } } }} onPressEnter={() => void save()} />
                </Form.Item>
                <div className="access-grant-modal__list-heading"><Typography.Text strong>Проекты <Typography.Text type="secondary">· выбрано {checkedCount}</Typography.Text></Typography.Text><Input.Search aria-label="Найти проект для выдачи доступа" placeholder="Найти проект" value={search} onChange={event => setSearch(event.target.value)} allowClear /></div>
                <div className="access-grant-modal__projects">
                    {!loading && !loadError && visibleProjects.length === 0 && <Typography.Paragraph type="secondary">{search.trim() ? 'Нет проектов с таким названием.' : 'Нет проектов, которыми вы можете управлять.'}</Typography.Paragraph>}
                    {visibleProjects.map(project => {
                        const entry = grants[project.id] ?? { checked: false, role: 'Наблюдатель' };
                        const locked = !main && initial.some(ref => ref.projectId === project.id && ref.role === 'Админ проекта');
                        const readonly = projectRoleLevel(user, project.id) < 3;
                        return <div key={project.id} className="access-grant-modal__project">
                            <Checkbox checked={entry.checked} disabled={locked || readonly || saving || loading} onChange={event => setGrants(map => ({ ...map, [project.id]: { ...entry, checked: event.target.checked } }))}><Typography.Text>{project.name}</Typography.Text></Checkbox>
                            {locked ? <Space direction="vertical" size={2}><Tag>Админ проекта</Tag><Typography.Text type="secondary">Изменяет главный админ</Typography.Text></Space> : <Select aria-label={`Роль в проекте ${project.name}`} value={entry.role} options={PROJECT_ROLE_OPTIONS.filter(option => main || option.value !== 'Админ проекта')} disabled={!entry.checked || readonly || saving || loading} onChange={(role: string) => setGrants(map => ({ ...map, [project.id]: { ...entry, role } }))} />}
                        </div>;
                    })}
                </div>
            </Form>
        </Spin>
        <div className="access-grant-modal__roles"><Typography.Text type="secondary">Наблюдатель читает данные. Разработчик работает с инструментами. Админ проекта управляет каталогом и участниками своего проекта.</Typography.Text>{!main && <Typography.Text type="secondary">Роль «Админ проекта» назначает главный админ.</Typography.Text>}</div>
    </Modal>;
}
