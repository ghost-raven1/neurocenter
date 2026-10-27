import {EditOutlined, MenuOutlined, ReloadOutlined, SettingOutlined, TeamOutlined} from '@ant-design/icons';
import {Alert, Button, Space, Spin, Tag, Tooltip, Typography} from 'antd';
import {useEffect, useRef, useState, type RefObject} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {ProjectChatComposer} from './ProjectChatComposer';
import {ProjectChatMessages} from './ProjectChatMessages';
import {ProjectChatParticipants} from './ProjectChatParticipants';
import {ProjectChatDialogForm} from './ProjectChatDialogForm';
import {ProjectChatPanel} from './ProjectChatPanel';
import {ProjectChatRooms} from './ProjectChatRooms';
import {useProjectChatRooms} from './useProjectChatRooms';
import {useProjectChat} from './useProjectChat';
import {useProjectChatActivity} from './useProjectChatActivity';
import {ProjectChatPresence, ProjectChatTyping} from './ProjectChatActivity';
import {DEFAULT_PROJECT_CHAT_ROOM, type ProjectChatMessage, type ProjectChatRoomSummary} from './types';
import {chatRoleOriginKey, type ChatRoleOrigin} from '../ChatSystemRoles/types';
import {openModelChat} from '../ModelChat/chatNavigation';
import {SystemRoleChat} from '../SystemRoleChat/SystemRoleChat';
import './ProjectChat.less';

interface Props {projectId: string; projectName?: string;}
interface RoomProps extends Props {
    roomId: string; selected?: ProjectChatRoomSummary; listOpen: boolean; menuRef: RefObject<HTMLButtonElement>;
    onOpenList: () => void; onManage: (room: ProjectChatRoomSummary) => void; onAccessLost: (id: string) => void;
}

function ProjectChatRoomScope({projectId, roomId, selected, listOpen, menuRef, onOpenList, onManage, onAccessLost}: RoomProps): JSX.Element {
    const {scope} = useAuthRequestOwner(), chat = useProjectChat(projectId, roomId), flags = useFeatureAvailability('project_chat', ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const]));
    const [reply, setReply] = useState<ProjectChatMessage>(), [panel, setPanel] = useState<'people' | 'agents'>(), [frozen, setFrozen] = useState(false);
    const origin: ChatRoleOrigin = {kind: 'project-chat', originId: roomId, projectId}, originKey = chatRoleOriginKey(origin);
    const detail = chat.detail;
    const activity = useProjectChatActivity(projectId, roomId, detail, chat.clearAccess);
    useEffect(() => {if (chat.accessDenied && roomId !== DEFAULT_PROJECT_CHAT_ROOM) onAccessLost(roomId);}, [chat.accessDenied, roomId, onAccessLost]);
    const openPanel = (name: 'people' | 'agents', open: boolean): void => setPanel(current => open ? name : current === name ? undefined : current);
    const title = detail?.room.title ?? (detail ? roomId === DEFAULT_PROJECT_CHAT_ROOM ? 'Общий чат' : 'Диалог команды' : chat.loading ? 'Открываем диалог…' : 'Диалог команды');
    return <section className="project-chat" aria-label="Команда проекта">
        <div className="project-chat__heading"><div className="project-chat__room-title"><Typography.Text strong title={title}>{title}</Typography.Text>
            {detail && <Typography.Text type="secondary">{detail.room.visibility === 'PRIVATE' ? 'Закрытый · только участники диалога' : 'Весь проект'}</Typography.Text>}</div>
            <Space size={4}><Button ref={menuRef} className="project-chat__mobile-menu" type="text" icon={<MenuOutlined/>} aria-expanded={listOpen} aria-controls="project-chat-rooms" onClick={onOpenList}>Диалоги</Button>
                {detail && <ProjectChatPanel label="Участники диалога" icon={<TeamOutlined/>} open={panel === 'people'} onOpenChange={open => openPanel('people', open)}>
                    <div className="project-chat__participants"><Typography.Text strong>Участники · {detail.members.length}</Typography.Text><ul>{detail.members.map(member => <li key={member.email}><div><Typography.Text strong>{member.displayName || member.email}</Typography.Text><Typography.Text type="secondary">{member.role}</Typography.Text></div>
                        <ProjectChatPresence email={member.email} activity={activity.snapshot} connected={activity.connected} enabled={activity.enabled}/></li>)}</ul>
                        <Typography.Text strong>Агенты · {detail.room.agentIds.length}</Typography.Text><div className="project-chat__roster-agents">{detail.agents.filter(agent => detail.room.agentIds.includes(agent.agentId)).map(agent => <Tag key={agent.agentId} color={agent.status === 'active' ? undefined : 'warning'}>{agent.name}{agent.status === 'active' ? ' · доступен для запросов' : ' · недоступен'}</Tag>)}</div>
                        {!detail.room.agentIds.length && <Typography.Text type="secondary">Агенты не подключены. Участники могут переписываться без модели.</Typography.Text>}</div>
                </ProjectChatPanel>}
                {detail?.canConfigure && <ProjectChatPanel label="Настроить агентов" icon={<SettingOutlined/>} open={panel === 'agents'} onOpenChange={open => openPanel('agents', open)} disabled={!!chat.action}>
                    <ProjectChatParticipants projectId={projectId} detail={detail} saving={chat.action === 'participants'} error={chat.error} onSave={chat.configure} onClose={() => setPanel(undefined)}/>
                </ProjectChatPanel>}
                {detail && selected?.canManage && <Tooltip title="Настройки диалога" placement="bottom" trigger={['hover', 'focus']}><Button className="project-chat__icon-action" type="text" size="small" icon={<EditOutlined/>} aria-label="Настройки диалога" onClick={() => onManage(selected)}/></Tooltip>}
                <Tooltip title="Проверить связь" placement="bottom" trigger={['hover', 'focus']}><Button className="project-chat__icon-action" type="text" size="small" icon={<ReloadOutlined/>} aria-label="Проверить связь" loading={chat.loading} onClick={() => {void chat.refresh();}}/></Tooltip>
            </Space></div>
        {chat.error && <Alert className="project-chat__notice" type="error" showIcon message={chat.error} action={<Button onClick={() => {void chat.refresh();}}>Повторить</Button>}/>}
        {!detail ? chat.loading ? <div className="project-chat__loading" role="status"><Spin tip="Открываем чат команды…"/></div> : null : <>
            <ProjectChatMessages projectId={projectId} messages={detail.messages} members={detail.members} activity={activity.snapshot} onVisible={activity.onVisible} canReply={detail.canPost && flags.enabled && !frozen} action={chat.action} retryPending={chat.retryPending} historyLoading={chat.historyLoading} historyError={chat.historyError} hasMore={detail.history.hasMore}
                privateTasks={<SystemRoleChat key={originKey} embedded origin={origin} projectId={projectId} canExecute={false} historyOnly/>}
                onLoadEarlier={() => {void chat.loadEarlier();}} onReply={setReply} onRetry={id => {void chat.retry(id);}} onCancel={id => {void chat.cancel(id);}}/>
            <ProjectChatTyping activity={activity.snapshot} members={detail.members} connected={activity.connected} enabled={activity.enabled}/>
            <ProjectChatComposer draftKey={JSON.stringify([scope, projectId, roomId])} detail={detail} reply={reply} onCancelReply={() => setReply(undefined)} onFrozenChange={setFrozen} onTyping={activity.onTyping} onSend={chat.send} onSystemRole={launch => {if (launch) openModelChat({projectId, agentId: launch.agentId, instruction: launch.instruction});}}
/>
        </>}
    </section>;
}

function ProjectChatScope(props: Props): JSX.Element {
    const {scope} = useAuthRequestOwner(), dialogs = useProjectChatRooms(props.projectId), flag = useFeatureAvailability('project_chat_dialogs');
    const [form, setForm] = useState<'new' | ProjectChatRoomSummary>(), [listOpen, setListOpen] = useState(false);
    const rail = useRef<HTMLElement>(null), menu = useRef<HTMLButtonElement>(null), wasOpen = useRef(false);
    useEffect(() => {
        if (listOpen) (rail.current?.querySelector<HTMLButtonElement>('[aria-current="page"]') ?? rail.current?.querySelector<HTMLButtonElement>('button:not([disabled])'))?.focus();
        else if (wasOpen.current) menu.current?.focus();
        wasOpen.current = listOpen;
    }, [listOpen]);
    const selected = dialogs.data?.rooms.find(room => room.id === dialogs.roomId);
    const select = (id: string): void => {if (dialogs.data?.rooms.some(room => room.id === id)) {dialogs.select(id); setListOpen(false);}};
    return <div className="project-chat-workspace">
        {dialogs.error && <Alert className="project-chat__notice" type="error" showIcon message={dialogs.error} action={<Button size="small" onClick={() => {void dialogs.refresh();}}>Обновить диалоги</Button>}/>}
        {!flag.enabled && <Typography.Text className="project-chat__notice" type="secondary">{flag.reason} История диалогов и остановка ответов доступны.</Typography.Text>}
        <div className={'project-chat__layout' + (listOpen ? ' project-chat__layout_list-open' : '')} onKeyDown={event => {if (listOpen && event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); setListOpen(false);}}}>
            <aside ref={rail} id="project-chat-rooms" className="project-chat__sidebar"><ProjectChatRooms rooms={dialogs.data?.rooms ?? []} selected={dialogs.roomId} loading={dialogs.loading}
                canCreate={!!dialogs.data?.canCreate && flag.enabled} createReason={!flag.enabled ? flag.reason : dialogs.loading ? 'Проверяем доступ к диалогам…' : !dialogs.data ? 'Обновите список диалогов, чтобы проверить доступ.' : !dialogs.data.canCreate ? 'Для создания диалога нужна роль разработчика проекта.' : undefined}
                onSelect={select} onNew={() => setForm('new')} onRefresh={() => {void dialogs.refresh();}}/></aside>
            <ProjectChatRoomScope key={JSON.stringify([scope, props.projectId, dialogs.roomId])} {...props} roomId={dialogs.roomId} selected={selected} listOpen={listOpen} menuRef={menu}
                onOpenList={() => setListOpen(true)} onManage={setForm} onAccessLost={dialogs.forget}/>
            {listOpen && <Button className="project-chat__mobile-list-close" onClick={() => setListOpen(false)}>Вернуться к чату</Button>}
        </div>
        {form && (form === 'new' ? dialogs.data?.canCreate : dialogs.data?.rooms.some(room => room.id === form.id)) && <ProjectChatDialogForm key={form === 'new' ? 'new' : form.id} draftKey={JSON.stringify([scope, props.projectId])} room={form === 'new' ? undefined : form} members={dialogs.data?.members ?? []}
            onClose={() => {setForm(undefined); setListOpen(false);}} onCreate={dialogs.create} onUpdate={dialogs.update} onCompare={dialogs.compare}/>}
    </div>;
}

/** A user, project and dialogue own every draft, reply and HTTP result. */
export function ProjectChatWorkspace(props: Props): JSX.Element {
    const {scope} = useAuthRequestOwner();
    return <ProjectChatScope key={JSON.stringify([scope, props.projectId])} {...props}/>;
}
