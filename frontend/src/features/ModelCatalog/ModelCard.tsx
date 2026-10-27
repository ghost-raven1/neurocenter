import {Children,type ReactNode} from 'react';
import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { CloudOutlined, DatabaseOutlined, DesktopOutlined } from '@ant-design/icons';
import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import { ArchiveAssetButton } from '../AssetManagement/ArchiveAssetButton';
import { eligibleEmbedding } from '../ProjectEmbedding/model';
import { modelCapabilityLabels, modelLocationLabel, modelUsesApiConnection } from './modelCatalogState';
import { ModelHosting } from './ModelHosting';
import type { ICatalogModel } from './types';

interface IProps {
    model: ICatalogModel; assigned: boolean; projectSelected: boolean; canAssign: boolean;
    canHost: boolean; busy: boolean; onAssign: () => void; onView: () => void;
    disabled?: boolean; onEdit?: () => void; onRemove?: () => void; onConfigure?: () => void;
    assignmentUnavailableReason?: string;onConnect?:()=>void;connectionUnavailableReason?:string;
    connectionStatus?: 'checking' | 'unknown' | 'connected';
    embeddingSetupHref?:string;
    onChat?: () => void; chatUnavailableReason?: string;
    onSetupProvider?: () => void;
    feedback?: ReactNode;
}

/** В карточке видны назначение, подключение и главное действие; технические сведения открываются отдельно. */
export function ModelCard({ model, assigned, projectSelected, canAssign, canHost, busy, disabled, assignmentUnavailableReason, onAssign, onView, onEdit, onRemove, onConfigure,onConnect,connectionUnavailableReason,connectionStatus,embeddingSetupHref,onChat,chatUnavailableReason,onSetupProvider, feedback }: IProps): JSX.Element {
    const remote = modelUsesApiConnection(model), deviceCodex = model.runtime === 'device-codex';
    const assignable=projectSelected&&canAssign,chat=model.capability!=='embedding'&&!!onChat;
    const connect=assignable&&assigned&&!!onConnect&&eligibleEmbedding(model)&&!model.archivedAt;
    const prepare=!!embeddingSetupHref&&assignable&&eligibleEmbedding(model)&&!model.archivedAt;
    const primary=assignable&&!assigned?'assign':prepare?'prepare':connect?'connect':chat&&(!projectSelected||assigned)?'chat':undefined;
    const actions={
        assign:assignable&&<Tooltip title={assignmentUnavailableReason}><span aria-label={assignmentUnavailableReason} tabIndex={assignmentUnavailableReason?0:undefined}><FeatureButton features={assigned?[]:['model_catalog']} type={primary==='assign'?'primary':'default'} loading={busy} disabled={busy||disabled||!!assignmentUnavailableReason||!!model.archivedAt&&!assigned} onClick={onAssign}>{assigned?'Убрать из проекта':'Добавить в проект'}</FeatureButton></span></Tooltip>,
        connect:connect&&<Tooltip title={connectionUnavailableReason}><span aria-label={connectionUnavailableReason} tabIndex={connectionUnavailableReason?0:undefined}><FeatureButton features={['model_catalog','rag_sync','model_hosting']} type={primary==='connect'?'primary':'default'} loading={busy} disabled={busy||disabled||!!connectionUnavailableReason||!!connectionStatus} onClick={onConnect}>{connectionStatus==='connected'?'Модель подключена':connectionStatus==='checking'?'Проверяем подключение':connectionStatus==='unknown'?'Подключение не проверено':'Подключить модель'}</FeatureButton></span></Tooltip>,
        chat:chat&&<Tooltip title={chatUnavailableReason}><span aria-label={chatUnavailableReason} tabIndex={chatUnavailableReason?0:undefined}><Button type={primary==='chat'?'primary':'default'} aria-label={`Чат с моделью ${model.name}`} disabled={busy||disabled||!!chatUnavailableReason} onClick={onChat}>Чат</Button></span></Tooltip>,
        prepare:prepare&&<FeatureButton features={['tool_installation']} type={primary==='prepare'?'primary':'default'} href={embeddingSetupHref} disabled={busy||disabled}>Подготовить OpenCodeRAG</FeatureButton>,
    };
    const secondary=Children.toArray([
        ...Object.entries(actions).filter(([key])=>key!==primary).map(([,action])=>action),
        remote&&canHost&&!model.archivedAt&&onConfigure&&<FeatureButton key="api" features={['model_catalog']} disabled={busy||disabled} aria-label={`Настроить API модели ${model.name}`} onClick={onConfigure}>Настроить API</FeatureButton>,
        deviceCodex&&canHost&&!model.archivedAt&&onConfigure&&<Button key="codex" disabled={busy||disabled} aria-label={`Подключение Codex модели ${model.name}`} onClick={onConfigure}>Компьютер и вход</Button>,
        (model.runtime==='remote-openai'||model.runtime==='remote-ollama')&&model.capability!=='embedding'&&assignable&&assigned&&onSetupProvider&&!model.archivedAt&&<Button key="provider" disabled={busy||disabled} onClick={onSetupProvider}>Настроить в OpenCode</Button>,
        canHost&&onEdit&&<FeatureButton key="edit" features={['model_catalog']} disabled={busy||disabled||!!model.archivedAt} aria-label={`Изменить модель ${model.name}`} onClick={onEdit}>Изменить модель</FeatureButton>,
        canHost&&onRemove&&!model.archivedAt&&<ArchiveAssetButton key="archive" kind="model" id={model.id} disabled={busy||disabled} onArchived={onRemove} buttonProps={{'aria-label':`Убрать из каталога модель ${model.name}`}}>Убрать из каталога</ArchiveAssetButton>,
    ]);
    return <article className={`model-card${assigned ? ' model-card_assigned' : ''}`} aria-label={model.name}>
        <div className="model-card__heading">
            <span className="model-card__icon" aria-hidden="true">{deviceCodex ? <DesktopOutlined /> : remote ? <CloudOutlined /> : <DatabaseOutlined />}</span>
            <div className="model-card__title"><Button type="link" aria-label={`Подробнее о модели: ${model.name}`} onClick={onView}>{model.name}</Button>
                <span>{modelCapabilityLabels[model.capability]}<span aria-hidden="true"> · </span>{modelLocationLabel(model)}</span></div>
        </div>
        <Typography.Paragraph type="secondary" className="model-card__description" ellipsis={{ rows: 3, tooltip: model.description }}>{model.description || 'Описание пока не добавлено.'}</Typography.Paragraph>
        <div className="model-card__identity"><span title={model.model}>{model.model}</span>
            {model.dimension && <span>{model.dimension} измерений</span>}
            {model.archivedAt && <Tag>Убрана из общего каталога</Tag>}
        </div>
        <ModelHosting model={model} canManage={canHost && !disabled && !model.archivedAt} compact onManage={onConfigure ?? onView} />
        {feedback}
        <div className="model-card__actions">
            {primary&&actions[primary]}
            {!assignable&&<Typography.Text type="secondary">{projectSelected?assigned?'Доступна участникам проекта':'Добавляет администратор проекта':'Выберите проект для добавления модели'}</Typography.Text>}
            {!!secondary.length&&<details className="model-card__more"><summary aria-label={`Другие действия с моделью ${model.name}`}>Другие действия</summary><Space wrap className="model-card__more-content">{secondary}</Space></details>}
            {assigned && <Tag color="blue">В проекте</Tag>}
        </div>
    </article>;
}
