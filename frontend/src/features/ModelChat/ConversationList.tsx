import {PlusOutlined, ReloadOutlined} from '@ant-design/icons';
import {Button, Empty, Input, Tooltip, Typography} from 'antd';
import {useState} from 'react';
import type {IModelChatConversation} from './types';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';

interface Props {items: IModelChatConversation[]; selected?: string; disabled: boolean; newDisabled?: boolean; loading: boolean; onSelect: (id: string) => void; onNew: () => void; onRefresh: () => void;}

export function ConversationList({items, selected, disabled, newDisabled, loading, onSelect, onNew, onRefresh}: Props): JSX.Element {
    const [query, setQuery] = useState('');
    const shown = items.filter(value => value.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    return <nav className="model-chat__conversations" aria-label="Личные диалоги">
        <div className="model-chat__list-heading"><Typography.Text strong>Мои диалоги</Typography.Text><Tooltip title="Обновить диалоги" placement="bottom" trigger={['hover','focus']}><Button className="model-chat__icon-action" size="small" type="text" icon={<ReloadOutlined/>} aria-label="Обновить диалоги" loading={loading} disabled={disabled} onClick={onRefresh}/></Tooltip></div>
        <FeatureButton features={['model_chat']} block type="primary" icon={<PlusOutlined/>} disabled={disabled || newDisabled} onClick={onNew}>Новый диалог</FeatureButton>
        <Input.Search aria-label="Поиск диалогов" placeholder="Найти диалог" value={query} onChange={event => setQuery(event.target.value)} allowClear/>
        <div className="model-chat__conversation-items">{shown.map(value => <button key={value.id} type="button" className={'model-chat__conversation' + (value.id === selected ? ' model-chat__conversation_selected' : '')}
            aria-current={value.id === selected ? 'page' : undefined} disabled={disabled} onClick={() => onSelect(value.id)}>
            <span>{value.title}</span><time dateTime={value.updatedAt}>{value.mode === 'group' ? 'Группа агентов · ' : ''}{new Date(value.updatedAt).toLocaleDateString('ru-RU')}</time>
        </button>)}{!shown.length && !loading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? 'Ничего не найдено' : 'Диалогов пока нет'}/>}</div>
        <Typography.Text type="secondary" className="model-chat__privacy">История и документы доступны только вам.</Typography.Text>
    </nav>;
}
