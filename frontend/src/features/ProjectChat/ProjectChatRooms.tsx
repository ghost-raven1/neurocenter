import {LockOutlined, PlusOutlined, ReloadOutlined} from '@ant-design/icons';
import {Button, Empty, Tooltip, Typography} from 'antd';
import type {ProjectChatRoomSummary} from './types';

interface Props {
    rooms: ProjectChatRoomSummary[]; selected: string; loading: boolean; canCreate: boolean; createReason?: string;
    onSelect: (id: string) => void; onNew: () => void; onRefresh: () => void;
}

/** The rail only renders rooms returned for the current project and viewer. */
export function ProjectChatRooms({rooms, selected, loading, canCreate, createReason, onSelect, onNew, onRefresh}: Props): JSX.Element {
    return <nav className="project-chat__rooms" aria-label="Диалоги команды проекта">
        <div className="project-chat__list-heading"><Typography.Text strong>Диалоги проекта</Typography.Text>
            <Tooltip title="Обновить диалоги" placement="bottom" trigger={['hover', 'focus']}><Button className="project-chat__icon-action" type="text" size="small" icon={<ReloadOutlined/>}
                aria-label="Обновить диалоги" loading={loading} onClick={onRefresh}/></Tooltip></div>
        <Button block type="primary" icon={<PlusOutlined/>} disabled={!canCreate} title={createReason} onClick={onNew}>Новый диалог</Button>
        <div className="project-chat__room-items" aria-busy={loading}>{rooms.map(room => <button key={room.id} type="button" className={'project-chat__room' + (room.id === selected ? ' project-chat__room_selected' : '')}
            aria-current={room.id === selected ? 'page' : undefined} onClick={() => onSelect(room.id)}>
            <span title={room.title}>{room.visibility === 'PRIVATE' && <LockOutlined aria-hidden/>}{room.title}</span>
            <small>{room.visibility === 'PRIVATE' ? 'Только участники диалога' : 'Весь проект'}</small>
        </button>)}{!rooms.length && !loading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Диалоги пока не загружены. Обновите список."/>}</div>
        <Typography.Text type="secondary" className="project-chat__rail-note">Общие диалоги видит весь проект. Закрытые — только их участники.</Typography.Text>
    </nav>;
}
