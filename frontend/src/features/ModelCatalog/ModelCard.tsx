import { CloudOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { Button, Tag, Tooltip, Typography } from 'antd';
import { ArchiveAssetButton } from '../AssetManagement/ArchiveAssetButton';
import { eligibleEmbedding } from '../ProjectEmbedding/model';
import { modelCapabilityLabels } from './modelCatalogState';
import { ModelHosting } from './ModelHosting';
import type { ICatalogModel } from './types';

interface IProps {
    model: ICatalogModel; assigned: boolean; projectSelected: boolean; canAssign: boolean;
    canHost: boolean; busy: boolean; onAssign: () => void; onView: () => void;
    disabled?: boolean; onEdit?: () => void; onRemove?: () => void; onConfigure?: () => void;
    assignmentUnavailableReason?: string;onConnect?:()=>void;connectionUnavailableReason?:string;
}

/** В карточке видны назначение, подключение и главное действие; технические сведения открываются отдельно. */
export function ModelCard({ model, assigned, projectSelected, canAssign, canHost, busy, disabled, assignmentUnavailableReason, onAssign, onView, onEdit, onRemove, onConfigure,onConnect,connectionUnavailableReason }: IProps): JSX.Element {
    const remote = model.runtime !== 'ollama';
    return <article className={`model-card${assigned ? ' model-card_assigned' : ''}`} aria-label={model.name}>
        <div className="model-card__heading">
            <span className="model-card__icon" aria-hidden="true">{remote ? <CloudOutlined /> : <DatabaseOutlined />}</span>
            <div className="model-card__title"><Button type="link" aria-label={`Подробнее о модели: ${model.name}`} onClick={onView}>{model.name}</Button>
                <span>{modelCapabilityLabels[model.capability]}<span aria-hidden="true"> · </span>{remote ? 'Удалённый API' : 'На сервере'}</span></div>
            {canHost && <div className="model-card__management">
                {onEdit && <Tooltip title="Изменить модель"><Button type="text" icon={<EditOutlined />} disabled={busy || disabled || !!model.archivedAt}
                    aria-label={`Изменить модель ${model.name}`} onClick={onEdit} /></Tooltip>}
                {onRemove && !model.archivedAt && <Tooltip title="Убрать из каталога"><span><ArchiveAssetButton kind="model" id={model.id} disabled={busy || disabled} onArchived={onRemove}
                    buttonProps={{ type: 'text', icon: <DeleteOutlined />, 'aria-label': `Убрать из каталога модель ${model.name}` }} children={null} /></span></Tooltip>}
            </div>}
        </div>
        <Typography.Paragraph type="secondary" className="model-card__description" ellipsis={{ rows: 3, tooltip: model.description }}>{model.description || 'Описание пока не добавлено.'}</Typography.Paragraph>
        <div className="model-card__identity"><span title={model.model}>{model.model}</span>
            {model.dimension && <span>{model.dimension} измерений</span>}
            {model.archivedAt && <Tag>Убрана из общего каталога</Tag>}
        </div>
        <ModelHosting model={model} canManage={canHost && !disabled && !model.archivedAt} compact onManage={onConfigure ?? onView} />
        <div className="model-card__actions">
            <Button type="text" onClick={onView}>Подробнее</Button>
            {projectSelected&&canAssign&&assigned&&onConnect&&eligibleEmbedding(model)&&!model.archivedAt&&<Tooltip title={connectionUnavailableReason}><span aria-label={connectionUnavailableReason} tabIndex={connectionUnavailableReason?0:undefined}>
                <Button type="primary" loading={busy} disabled={busy||disabled||!!connectionUnavailableReason} onClick={onConnect}>Подключить модель</Button>
            </span></Tooltip>}
            {projectSelected && canAssign ? <Tooltip title={assignmentUnavailableReason}><span aria-label={assignmentUnavailableReason} tabIndex={assignmentUnavailableReason?0:undefined}><Button type={assigned ? 'default' : 'primary'} loading={busy} disabled={busy || disabled || !!assignmentUnavailableReason || !!model.archivedAt && !assigned} onClick={onAssign}>
                {assigned ? 'Убрать из проекта' : 'Добавить в проект'}
            </Button></span></Tooltip> : <Typography.Text type="secondary">{projectSelected ? assigned ? 'Доступна участникам проекта' : 'Добавляет администратор проекта' : 'Выберите проект для добавления модели'}</Typography.Text>}
            {assigned && <Tag color="blue">В проекте</Tag>}
        </div>
    </article>;
}
