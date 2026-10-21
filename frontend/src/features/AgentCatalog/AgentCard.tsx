import { DeleteOutlined, EditOutlined, RobotOutlined } from '@ant-design/icons';
import { Button, Tag, Tooltip, Typography } from 'antd';
import { ArchiveAssetButton } from '../AssetManagement/ArchiveAssetButton';
import { agentModeLabels } from './model';
import type { IAgentStatus } from './model';
import type { ICatalogAgent, IProjectAgent } from './types';

interface IProps {
    agent: ICatalogAgent; assignment?: IProjectAgent; status?: IAgentStatus;
    projectSelected: boolean; isMain: boolean; canManage: boolean; busy: boolean; unavailable: boolean;
    onView: () => void; onEdit: () => void; onArchived: () => void; onAssign: () => void;
    onConfigure: () => void; onToggle: () => void; onRemove: () => void; onUpdate: () => void;
}
const colors: Record<IAgentStatus['key'], string | undefined> = { pending: 'blue', error: 'red', enabled: 'green', disabled: undefined, removed: undefined, unapplied: 'orange' };

export function AgentCard({ agent, assignment, status, projectSelected, isMain, canManage, busy, unavailable, onView, onEdit, onArchived, onAssign, onConfigure, onToggle, onRemove, onUpdate }: IProps): JSX.Element {
    const active = assignment && !assignment.removed;
    const effective = active ? assignment.effective : agent.definition;
    return <article className={`agent-card${active ? ' agent-card_assigned' : ''}`} aria-label={agent.name}>
        <div className="agent-card__heading"><span className="agent-card__icon" aria-hidden="true"><RobotOutlined /></span>
            <div className="agent-card__title"><Button type="link" onClick={onView} aria-label={`Промпт агента ${agent.name}`}>{active ? assignment.card.name : agent.name}</Button>
                <span>{agentModeLabels[effective.mode]} · <code>@{active ? assignment.card.slug : agent.slug}</code></span></div>
            {isMain && <div className="agent-card__management"><Tooltip title="Изменить общий шаблон"><Button type="text" icon={<EditOutlined />} disabled={busy || unavailable || !!agent.archivedAt} aria-label={`Изменить агента ${agent.name}`} onClick={onEdit} /></Tooltip>
                <ArchiveAssetButton kind="agent" id={agent.id} restore={!!agent.archivedAt} disabled={busy || unavailable} onArchived={onArchived} children={null}
                    buttonProps={{ type: 'text', icon: <DeleteOutlined />, 'aria-label': `${agent.archivedAt ? 'Вернуть в каталог' : 'Удалить из каталога'} агента ${agent.name}` }} /></div>}
        </div>
        <Typography.Paragraph type="secondary" className="agent-card__description">{effective.description}</Typography.Paragraph>
        <div className="agent-card__identity"><Tag>Шаблон v{active ? assignment.version : agent.version}</Tag>{active && <Tag color="blue">В проекте</Tag>}{agent.archivedAt && <Tag>Убран из общего каталога</Tag>}{active && Object.keys(assignment.overrides).length > 0 && <Tag>Настроен для проекта</Tag>}</div>
        {status && assignment && <div className="agent-card__status" role="status" aria-live="polite"><Tag color={colors[status.key]}>{status.label}</Tag><Typography.Text type={status.key === 'error' ? 'danger' : 'secondary'}>{status.detail}</Typography.Text></div>}
        <div className="agent-card__actions"><Button type="text" onClick={onView}>Промпт</Button>
            {projectSelected && canManage ? active ? <>
                <Button disabled={busy || unavailable} onClick={onConfigure}>Настроить</Button>
                <Button type={assignment.enabled ? 'default' : 'primary'} disabled={busy || unavailable} onClick={onToggle}>{assignment.enabled ? 'Отключить' : 'Включить'}</Button>
                <Tooltip title="Убрать из проекта и удалить управляемый файл через мост"><Button danger type="text" icon={<DeleteOutlined />} disabled={busy || unavailable} aria-label={`Удалить из проекта агента ${assignment.card.name}`} onClick={onRemove} /></Tooltip>
            </> : <Button type="primary" disabled={busy || unavailable || !!agent.archivedAt} onClick={onAssign}>{assignment?.removed ? 'Вернуть в проект' : 'Добавить в проект'}</Button>
                : <Typography.Text type="secondary">{!projectSelected ? 'Выберите проект для добавления' : active ? 'Настройками управляет администратор проекта' : 'Добавляет администратор проекта'}</Typography.Text>}
        </div>
        {active && agent.version !== assignment.version && !agent.archivedAt && <div className="agent-card__update"><Typography.Text type="secondary">В каталоге доступен шаблон v{agent.version}. Проект сохраняет v{assignment.version}.</Typography.Text>{canManage && <Button size="small" disabled={busy || unavailable} onClick={onUpdate}>Обновить шаблон</Button>}</div>}
    </article>;
}
