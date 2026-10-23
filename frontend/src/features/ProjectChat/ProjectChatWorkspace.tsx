import {Alert, Button, Select, Space, Spin, Tag, Typography} from 'antd';
import {useEffect, useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {ProjectChatComposer} from './ProjectChatComposer';
import {ProjectChatMessages} from './ProjectChatMessages';
import {ProjectChatParticipants} from './ProjectChatParticipants';
import {ProjectChatDialogForm} from './ProjectChatDialogForm';
import {useProjectChatRooms} from './useProjectChatRooms';
import {useProjectChat} from './useProjectChat';
import {DEFAULT_PROJECT_CHAT_ROOM, type ProjectChatMessage, type ProjectChatRoomSummary} from './types';
import './ProjectChat.less';

interface Props {projectId: string; projectName?: string;}

function ProjectChatRoomScope({projectId, projectName, roomId, onAccessLost}: Props & {roomId: string; onAccessLost: (id: string) => void}): JSX.Element {
    const {scope} = useAuthRequestOwner(), chat = useProjectChat(projectId, roomId), flags = useFeatureAvailability('project_chat', ...(roomId === DEFAULT_PROJECT_CHAT_ROOM ? [] : ['project_chat_dialogs' as const]));
    const [reply, setReply] = useState<ProjectChatMessage>(), [settings, setSettings] = useState(false), [frozen, setFrozen] = useState(false);
    const detail = chat.detail;
    useEffect(() => {if (chat.accessDenied && roomId !== DEFAULT_PROJECT_CHAT_ROOM) onAccessLost(roomId);}, [chat.accessDenied, roomId, onAccessLost]);
    return <section className="project-chat" aria-label="Команда проекта">
        <div className="project-chat__heading"><div><Typography.Title level={4}>Команда{projectName ? ` · ${projectName}` : ' проекта'}</Typography.Title><Typography.Text type="secondary">{detail?.room.title ?? 'Общий чат'} · {detail?.room.visibility === 'PRIVATE' ? 'Только выбранные участники' : 'Весь проект'}</Typography.Text></div>
            <Space wrap>{detail?.canConfigure && <Button disabled={!!chat.action} onClick={() => setSettings(!settings)}>{settings ? 'Скрыть настройку' : 'Настроить агентов'}</Button>}<Button size="small" loading={chat.loading} onClick={() => {void chat.refresh();}}>Проверить связь</Button></Space></div>
        {chat.error && <Alert type="error" showIcon message={chat.error} action={<Button onClick={() => {void chat.refresh();}}>Повторить</Button>}/>}
        {!detail ? chat.loading ? <Spin tip="Открываем чат команды…"/> : null : <>
            <details className="project-chat__participants"><summary>Участники · {detail.members.length}<span>Агенты · {detail.room.agentIds.length}</span></summary><div><ul>{detail.members.map(member => <li key={member.email}><Typography.Text strong>{member.displayName || member.email}</Typography.Text><Typography.Text type="secondary">{member.role}</Typography.Text></li>)}</ul>
                <div>{detail.agents.filter(agent => detail.room.agentIds.includes(agent.agentId)).map(agent => <Tag key={agent.agentId} color={agent.status === 'active' ? undefined : 'warning'}>{agent.name}{agent.status === 'active' ? '' : ' · недоступен'}</Tag>)}</div></div></details>
            {settings && detail.canConfigure && <ProjectChatParticipants projectId={projectId} detail={detail} saving={chat.action === 'participants'} error={chat.error} onSave={chat.configure} onClose={() => setSettings(false)}/>}
            <ProjectChatMessages messages={detail.messages} canReply={detail.canPost && flags.enabled && !frozen} action={chat.action} retryPending={chat.retryPending} historyLoading={chat.historyLoading} historyError={chat.historyError} hasMore={detail.history.hasMore}
                onLoadEarlier={() => {void chat.loadEarlier();}} onReply={setReply} onRetry={id => {void chat.retry(id);}} onCancel={id => {void chat.cancel(id);}}/>
            <ProjectChatComposer draftKey={JSON.stringify([scope, projectId, roomId])} detail={detail} reply={reply} onCancelReply={() => setReply(undefined)} onFrozenChange={setFrozen} onSend={chat.send}/>
        </>}
    </section>;
}

function ProjectChatScope(props: Props): JSX.Element {
    const {scope} = useAuthRequestOwner(), dialogs = useProjectChatRooms(props.projectId), flag = useFeatureAvailability('project_chat_dialogs');
    const [form, setForm] = useState<'new' | ProjectChatRoomSummary>();
    const selected = dialogs.data?.rooms.find(room => room.id === dialogs.roomId);
    const options = dialogs.data?.rooms.map(room => ({value: room.id, label: `${room.visibility === 'PRIVATE' ? '🔒 ' : ''}${room.title}`})) ?? [{value: DEFAULT_PROJECT_CHAT_ROOM, label: 'Общий чат'}];
    return <div className="project-chat-workspace">
        <div className="project-chat__dialogs"><label>Диалог<Select aria-label="Диалог команды" value={dialogs.roomId} loading={dialogs.loading} options={options} onChange={dialogs.select}/></label>
            <Space wrap><Button disabled={!dialogs.data?.canCreate || !flag.enabled} title={!flag.enabled ? flag.reason : undefined} onClick={() => setForm('new')}>Новый диалог</Button>
                {selected?.canManage && <Button onClick={() => setForm(selected)}>Настройки диалога</Button>}
                <Button size="small" loading={dialogs.loading} onClick={() => {void dialogs.refresh();}}>Обновить диалоги</Button></Space>
        </div>
        {dialogs.error && <Alert type="error" showIcon message={dialogs.error}/>}
        {!flag.enabled && <Typography.Text type="secondary">{flag.reason} История диалогов и остановка ответов доступны.</Typography.Text>}
        <ProjectChatRoomScope key={JSON.stringify([scope, props.projectId, dialogs.roomId])} {...props} roomId={dialogs.roomId} onAccessLost={dialogs.forget}/>
        {form && (form === 'new' ? dialogs.data?.canCreate : dialogs.data?.rooms.some(room => room.id === form.id)) && <ProjectChatDialogForm key={form === 'new' ? 'new' : form.id} draftKey={JSON.stringify([scope, props.projectId])} room={form === 'new' ? undefined : form} members={dialogs.data?.members ?? []}
            onClose={() => setForm(undefined)} onCreate={dialogs.create} onUpdate={dialogs.update} onCompare={dialogs.compare}/>}
    </div>;
}

/** A user, project and dialogue own every draft, reply and HTTP result. */
export function ProjectChatWorkspace(props: Props): JSX.Element {
    const {scope} = useAuthRequestOwner();
    return <ProjectChatScope key={JSON.stringify([scope, props.projectId])} {...props}/>;
}
