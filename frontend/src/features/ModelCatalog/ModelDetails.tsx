import { Alert, Button, Descriptions, Modal, Popconfirm, Space, Typography } from 'antd';
import { modelCatalogApi } from './api';
import { modelCapabilityLabels } from './modelCatalogState';
import type { ICatalogModel } from './types';
import { useState } from 'react';
import { ModelSupplyModal } from './ModelSupplyModal';

interface IProps { model: ICatalogModel; canManage: boolean; busy: boolean; error: string; onClose: () => void; onEdit: () => void; onRemove: () => void; }

export function ModelDetails({ model, canManage, busy, error, onClose, onEdit, onRemove }: IProps): JSX.Element {
    const endpoint = (typeof window === 'undefined' ? '' : window.location.origin) + modelCatalogApi.endpoint(model.id);
    const [supply, setSupply] = useState(false);
    return <><Modal open title={model.name} onCancel={onClose} width={720} footer={<Space wrap>
        {canManage && <Button disabled={busy} onClick={onEdit}>Изменить описание</Button>}
        {canManage && <Button disabled={busy} onClick={() => setSupply(true)}>Подготовить поставку</Button>}
        {canManage && model.source === 'custom' && <Popconfirm title="Удалить модель из общего каталога?" onConfirm={onRemove} okText="Удалить" cancelText="Отмена">
            <Button danger loading={busy} disabled={busy}>Удалить модель</Button>
        </Popconfirm>}
        <Button disabled={busy} onClick={onClose}>Закрыть</Button>
    </Space>}>
        {error && <Alert showIcon type="error" message={error} className="model-catalog__notice" />}
        <Typography.Paragraph>{model.description || 'Описание пока не добавлено.'}</Typography.Paragraph>
        <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Назначение">{modelCapabilityLabels[model.capability]}</Descriptions.Item>
            <Descriptions.Item label="Идентификатор"><Typography.Text code className="model-catalog__code">{model.model}</Typography.Text></Descriptions.Item>
            {model.dimension && <Descriptions.Item label="Размерность">{model.dimension}</Descriptions.Item>}
            <Descriptions.Item label="Ollama API"><Typography.Text copyable={{ text: endpoint }} className="model-catalog__code">{endpoint}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="OpenAI API"><Typography.Text copyable={{ text: endpoint.replace(/\/api$/, '/v1') }} className="model-catalog__code">{endpoint.replace(/\/api$/, '/v1')}</Typography.Text></Descriptions.Item>
            {model.manifestSha256 && <Descriptions.Item label="SHA256 манифеста"><Typography.Text code className="model-catalog__code">{model.manifestSha256}</Typography.Text></Descriptions.Item>}
        </Descriptions>
        <Alert showIcon type="info" className="model-catalog__notice model-catalog__connection" message="Подключение через Нейроцентр"
            description="API защищён правами текущей сессии. Назначение модели добавляет доступ команде; настройка OpenCode и перестроение индекса базы знаний выполняются отдельно. Выгрузка из памяти сохраняет веса на сервере." />
    </Modal>{supply && canManage && <ModelSupplyModal model={model} onClose={() => setSupply(false)} />}</>;
}
