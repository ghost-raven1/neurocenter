import {
    ApiOutlined,
    AppstoreOutlined,
    DownloadOutlined,
    ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, Card, Tag, Typography } from 'antd';
import { FC, ReactNode } from 'react';

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
export const KindBadge: FC<{ kind: TStoreKind }> = ({ kind }) => {
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
            { k.icon }
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
    return (
        <Card className="store-card" title={
            <div className="store-card__identity"><span className="store-card__icon">{KIND[app.kind].icon}</span><div><Button type="link" className="store-card__title" title={app.name} aria-label={`Подробнее: ${app.name}`} onClick={onView}>{app.name}</Button><KindBadge kind={app.kind} /></div></div>
        } extra={installed ? <Tag color="green">В проекте</Tag> : undefined}>
            <Paragraph type="secondary" ellipsis={{rows:3,tooltip:app.description}} style={{minHeight:66,marginBottom:0,lineHeight:'22px'}}>{app.description || 'Описание пока не добавлено. Откройте инструмент, чтобы прочитать его инструкцию.'}</Paragraph>
            <div className="store-card__tags">{app.tags.slice(0,3).map(tag => <Tag key={tag}>{tag}</Tag>)}</div>
            <div className="store-card__meta"><span>{stats?.installs ? <><DownloadOutlined /> {stats.installs} установок</> : 'В каталоге'}</span><Text type="secondary">Версия {app.version}</Text></div>
            <div className="store-card__actions">{action}</div>
        </Card>
    );
};

export default AppCard;
