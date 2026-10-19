import { DatabaseOutlined } from '@ant-design/icons';
import { Button, Card, Space, Tag, Typography } from 'antd';
import { modelCapabilityLabels } from './modelCatalogState';
import { ModelHosting } from './ModelHosting';
import type { ICatalogModel } from './types';

interface IProps {
    model: ICatalogModel; assigned: boolean; projectSelected: boolean; canAssign: boolean;
    canHost: boolean; busy: boolean; onAssign: () => void; onView: () => void;
}

export function ModelCard({ model, assigned, projectSelected, canAssign, canHost, busy, onAssign, onView }: IProps): JSX.Element {
    return <Card className="model-card" title={<div className="store-card__identity">
        <span className="store-card__icon"><DatabaseOutlined /></span>
        <div><Button type="link" className="store-card__title" aria-label={`Подробнее о модели: ${model.name}`} onClick={onView}>{model.name}</Button>
            <Typography.Text type="secondary">{modelCapabilityLabels[model.capability]}</Typography.Text></div>
    </div>} extra={assigned ? <Tag color="blue">В проекте</Tag> : undefined}>
        <Typography.Paragraph type="secondary" className="model-card__description" ellipsis={{ rows: 3, tooltip: model.description }}>{model.description || 'Описание пока не добавлено.'}</Typography.Paragraph>
        <Space wrap size={[4, 8]} className="model-card__identity"><Typography.Text code>{model.model}</Typography.Text>
            {model.dimension && <Tag>{model.dimension} измерений</Tag>}<Tag>{model.source === 'builtin' ? 'Встроенная' : 'Добавлена вручную'}</Tag>
        </Space>
        <ModelHosting model={model} canManage={canHost} />
        <div className="model-card__actions">
            {projectSelected && canAssign ? <Button block type={assigned ? 'default' : 'primary'} loading={busy} disabled={busy} onClick={onAssign}>
                {assigned ? 'Убрать из проекта' : 'Добавить в проект'}
            </Button> : <Typography.Text type="secondary">{projectSelected ? assigned ? 'Доступна участникам проекта' : 'Добавляет администратор проекта' : 'Выберите проект для добавления модели'}</Typography.Text>}
        </div>
    </Card>;
}
