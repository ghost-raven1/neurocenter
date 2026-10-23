import {Alert, Button, Space, Spin, Tag, Typography} from 'antd';
import {useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {ProjectChatComposer} from './ProjectChatComposer';
import {ProjectChatMessages} from './ProjectChatMessages';
import {ProjectChatParticipants} from './ProjectChatParticipants';
import {useProjectChat} from './useProjectChat';
import type {ProjectChatMessage} from './types';
import './ProjectChat.less';

interface Props {projectId: string; projectName?: string;}

function ProjectChatScope({projectId, projectName}: Props): JSX.Element {
    const {scope} = useAuthRequestOwner(), chat = useProjectChat(projectId), flags = useFeatureAvailability('project_chat');
    const [reply, setReply] = useState<ProjectChatMessage>(), [settings, setSettings] = useState(false), [frozen, setFrozen] = useState(false);
    const detail = chat.detail;
    return <section className="project-chat" aria-label="Команда проекта">
        <div className="project-chat__heading"><div><Typography.Title level={4}>Команда{projectName ? ` · ${projectName}` : ' проекта'}</Typography.Title><Typography.Text type="secondary">Общая переписка участников и ответы агентов на каждый вопрос.</Typography.Text></div>
            <Space wrap>{detail?.canConfigure && <Button disabled={!!chat.action} onClick={() => setSettings(!settings)}>{settings ? 'Скрыть настройку' : 'Настроить агентов'}</Button>}<Button size="small" loading={chat.loading} onClick={() => {void chat.refresh();}}>Проверить связь</Button></Space></div>
        {chat.error && <Alert type="error" showIcon message={chat.error} action={<Button onClick={() => {void chat.refresh();}}>Повторить</Button>}/>}
        {!detail ? chat.loading ? <Spin tip="Открываем чат команды…"/> : null : <>
            <details className="project-chat__participants"><summary>Участники · {detail.members.length}<span>Агенты · {detail.room.agentIds.length}</span></summary><div><ul>{detail.members.map(member => <li key={member.email}><Typography.Text strong>{member.displayName || member.email}</Typography.Text><Typography.Text type="secondary">{member.role}</Typography.Text></li>)}</ul>
                <div>{detail.agents.filter(agent => detail.room.agentIds.includes(agent.agentId)).map(agent => <Tag key={agent.agentId} color={agent.status === 'active' ? undefined : 'warning'}>{agent.name}{agent.status === 'active' ? '' : ' · недоступен'}</Tag>)}</div></div></details>
            {settings && detail.canConfigure && <ProjectChatParticipants projectId={projectId} detail={detail} saving={chat.action === 'participants'} error={chat.error} onSave={chat.configure} onClose={() => setSettings(false)}/>}
            <ProjectChatMessages messages={detail.messages} canReply={detail.canPost && flags.enabled && !frozen} action={chat.action} retryPending={chat.retryPending} historyLoading={chat.historyLoading} historyError={chat.historyError} hasMore={detail.history.hasMore}
                onLoadEarlier={() => {void chat.loadEarlier();}} onReply={setReply} onRetry={id => {void chat.retry(id);}} onCancel={id => {void chat.cancel(id);}}/>
            <ProjectChatComposer draftKey={JSON.stringify([scope, projectId])} detail={detail} reply={reply} onCancelReply={() => setReply(undefined)} onFrozenChange={setFrozen} onSend={chat.send}/>
        </>}
    </section>;
}

/** The auth scope and project own every request, draft and selected reply in this shared workspace. */
export function ProjectChatWorkspace(props: Props): JSX.Element {
    const {scope} = useAuthRequestOwner();
    return <ProjectChatScope key={JSON.stringify([scope, props.projectId])} {...props}/>;
}
