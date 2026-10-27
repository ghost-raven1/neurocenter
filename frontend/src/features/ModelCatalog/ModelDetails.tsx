import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Collapse, Descriptions, Modal, Space, Typography } from 'antd';
import { ArchiveAssetButton } from '../AssetManagement/ArchiveAssetButton';
import { modelCatalogApi } from './api';
import { modelCapabilityLabels } from './modelCatalogState';
import type { ICatalogModel } from './types';
import { ModelHosting } from './ModelHosting';
import { ModelRateLimits } from '../ModelRateLimits/ModelRateLimits';

interface IProps { model: ICatalogModel; projectId?: string; canManage: boolean; busy: boolean; error: string; onClose: () => void; onEdit: () => void; onRemove: () => void; onConfigure?: () => void; }

export function ModelDetails({ model, projectId, canManage, busy, error, onClose, onEdit, onRemove, onConfigure }: IProps): JSX.Element {
    const endpoint = (typeof window === 'undefined' ? '' : window.location.origin) + modelCatalogApi.endpoint(model.id);
    return <Modal open centered className="model-details" title={model.name} onCancel={onClose} width={720} footer={<Button disabled={busy} onClick={onClose}>Закрыть</Button>}>
        {error && <Alert showIcon type="error" message={error} className="model-catalog__notice" />}
        <Typography.Paragraph>{model.description || 'Описание пока не добавлено.'}</Typography.Paragraph>
        <ModelHosting model={model} canManage={canManage && !model.archivedAt} onManage={onConfigure} />
        <ModelRateLimits modelId={model.id} projectId={projectId}/>
        {canManage&&!model.archivedAt&&<details className="model-catalog__more model-details__management"><summary aria-label={`Управление моделью ${model.name}`}>Управление моделью</summary><Space wrap className="model-catalog__more-content">
            <FeatureButton features={['model_catalog']} disabled={busy} onClick={onEdit}>Изменить модель</FeatureButton>
            {model.runtime==='device-codex'&&onConfigure&&<Button disabled={busy} onClick={onConfigure}>Компьютер и вход</Button>}
            <ArchiveAssetButton kind="model" id={model.id} disabled={busy} onArchived={onRemove}>Убрать из каталога</ArchiveAssetButton>
        </Space></details>}
        <Collapse ghost><Collapse.Panel key="technical" header="Технические сведения"><Descriptions layout="vertical" column={1} size="small" bordered>
            <Descriptions.Item label="Назначение">{modelCapabilityLabels[model.capability]}</Descriptions.Item>
            <Descriptions.Item label="Идентификатор"><Typography.Text code className="model-catalog__code">{model.model}</Typography.Text></Descriptions.Item>
            {model.dimension && <Descriptions.Item label="Размерность">{model.dimension}</Descriptions.Item>}
            <Descriptions.Item label="Ollama API"><Typography.Text copyable={{ text: endpoint }} className="model-catalog__code">{endpoint}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="OpenAI API"><Typography.Text copyable={{ text: endpoint.replace(/\/api$/, '/v1') }} className="model-catalog__code">{endpoint.replace(/\/api$/, '/v1')}</Typography.Text></Descriptions.Item>
            {model.manifestSha256 && <Descriptions.Item label="SHA256 манифеста"><Typography.Text code className="model-catalog__code">{model.manifestSha256}</Typography.Text></Descriptions.Item>}
        </Descriptions></Collapse.Panel></Collapse>
        <Typography.Paragraph type="secondary" className="model-catalog__connection">Запросы проходят через Нейроцентр с правами проекта. Изменение подключения не перестраивает существующий индекс автоматически.</Typography.Paragraph>
    </Modal>;
}
