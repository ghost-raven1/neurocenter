import {
    ApiOutlined,
    AppstoreOutlined,
    DownloadOutlined,
    ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, Card, Tag, Typography } from 'antd';
import { FC, ReactNode } from 'react';
import {storeCardPlatforms,storeCardRevision,storeCardSource} from './storeCardPresentation';

const { Text, Paragraph } = Typography;

/** Разновидности «приложений» в магазине. */
export type TStoreKind = 'mcp' | 'plugin' | 'skill';

/** Визуал типа приложения (иконка + цвет акцента). */
const KIND: Record<TStoreKind, { label: string; icon: ReactNode; color: string; bg: string }> = {
    mcp: { label: 'MCP', icon: <ApiOutlined />, color: '#108ee9', bg: '#e6f4ff' },
    plugin: { label: 'Плагин', icon: <AppstoreOutlined />, color: '#722ed1', bg: '#f3e8ff' },
    skill: { label: 'Скилл', icon: <ThunderboltOutlined />, color: '#d48806', bg: '#fff7e6' },
};

/** Счётчики приложения на витрине (установки/лайки/комментарии). */
export interface IStoreStats {
    installs: number;
    likes: number;
    comments: number;
}

/** Цветной бейдж типа (иконка + подпись) — общий вид для карточки и модалки. */
export const KindBadge: FC<{ kind: TStoreKind; icon?:boolean }> = ({ kind,icon=true }) => {
    const k = KIND[kind];
    return (
        <span
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '1px 8px',
                borderRadius: 10,
                background: k.bg,
                color: k.color,
                fontSize: 11.5,
                fontWeight: 600,
            }}
        >
            { icon&&k.icon }
            { k.label }
        </span>
    );
};

/**
 * Унифицированное «приложение» витрины (скилл/MCP/плагин в одном виде).
 */
export interface IStoreApp {
    /** Идентификатор: для скилла — path, для mcp/plugin — id каталога. */
    id: string;
    name: string;
    kind: TStoreKind;
    description: string;
    version: number;
    tags: string[];
    origin: string;
    /** Закреплённая ревизия поставки отличается от номера редакции карточки. */
    revision?: string|null;
    /** Путь скилла в каталоге (для резолва content). */
    path?: string;
    /** Техническое имя скилла; отображаемое название не определяет проектное назначение. */
    skillSlug?: string;
    /** Конфиг MCP (из каталога). */
    config?: Record<string, unknown>;
    /** Файлы плагина (из каталога) — для one-click установки дерева. */
    files?: { path: string; content?: string }[];
    /** Exact project snapshot не подменяется изменившимся head при открытии деталей. */
    projectCard?: import('./storeDetails').TStoreDetail;
    projectManifest?: string;
    pinError?: string;
    /** Кол-во файлов (для бандлов). */
    filesCount?: number;
}

interface IAppCardProps {
    app: IStoreApp;
    /** Отметка «Установлено» (для проектного магазина). */
    installed?: boolean;
    /** Счётчики (установки/лайки/комментарии). */
    stats?: IStoreStats;
    /** Открыть детали (клик по карточке). */
    onView?: () => void;
    /** Зона действий в футере (стандартизированные кнопки). */
    action: ReactNode;
}

/**
 * Карточка приложения на витрине магазина (единый вид для всех типов, app-store).
 * Клик по карточке — детали; действия — в футере (не влияют на высоту/не «едут»).
 *
 * @component
 * @param {IAppCardProps} props
 * @returns JSX-элемент карточки
 */
const AppCard: FC<IAppCardProps> = ({ app, installed, stats, onView, action }) => {
    const source=storeCardSource(app.origin),revision=storeCardRevision(app.revision),platforms=storeCardPlatforms(app.config);
    const description=app.description.trim(),tags=[...new Set(app.tags.map(tag=>tag.trim()).filter(Boolean))].slice(0,3);
    return (
        <Card className="store-card" title={
            <div className="store-card__identity"><span className="store-card__icon" aria-hidden="true">{KIND[app.kind].icon}</span><div><Button type="link" className="store-card__title" title={app.name} aria-label={`Подробнее: ${app.name}`} onClick={onView}>{app.name}</Button><KindBadge kind={app.kind} icon={false} /></div></div>
        } extra={installed ? <Tag color="green">В проекте</Tag> : undefined}>
            <Paragraph className="store-card__description" type="secondary" ellipsis={{rows:3,tooltip:description}}>{description || 'Описание пока не добавлено.'}</Paragraph>
            {tags.length>0&&<div className="store-card__tags">{tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</div>}
            {(source||platforms)&&<div className="store-card__facts">
                {source&&<Text type="secondary" className="store-card__source" title={source.label}>{source.label}</Text>}
                {platforms&&<Text type="secondary" title={platforms.title}>Платформы: {platforms.label}</Text>}
            </div>}
            <div className="store-card__meta">
                {revision&&<Text type="secondary">Поставка {revision}</Text>}
                {!!stats?.installs&&<span><DownloadOutlined /> {stats.installs} установок</span>}
                <Text type="secondary" className="store-card__edition">Редакция {app.version}</Text>
            </div>
            <div className="store-card__actions">{action}</div>
        </Card>
    );
};

export default AppCard;
