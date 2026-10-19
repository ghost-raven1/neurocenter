import { Alert, Button, Checkbox, Col, Empty, Input, Row, Space, Spin, Typography } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { modelCatalogApi } from './api';
import { ModelCard } from './ModelCard';
import { ModelDetails } from './ModelDetails';
import { ModelEditModal } from './ModelEditModal';
import { filterCatalogModels } from './modelCatalogState';
import type { ICatalogModel } from './types';
import { useModelCatalog } from './useModelCatalog';
import './ModelCatalog.less';

export interface IModelCatalogProps {
    projectId?: string;
    projectName?: string;
    embedded?: boolean;
    canManage: boolean;
    isMain: boolean;
}

/** Проект получает право на модель; веса и общий хостинг не копируются в каждый проект. */
export function ModelCatalog({ projectId, projectName, embedded, canManage, isMain }: IModelCatalogProps): JSX.Element {
    const { captureOwner } = useAuthRequestOwner();
    const { catalog, loading, error: loadError, refresh } = useModelCatalog(projectId);
    const [query, setQuery] = useState('');
    const [assignedOnly, setAssignedOnly] = useState(!!embedded);
    const [viewId, setViewId] = useState<string | null>(null);
    const [editing, setEditing] = useState<ICatalogModel | 'new' | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');
    const lock = useRef(false);
    const assigned = useMemo(() => new Set(catalog?.assignedModelIds ?? []), [catalog]);
    const shown = useMemo(() => catalog ? filterCatalogModels(catalog, query, !!projectId && assignedOnly) : [], [catalog, query, projectId, assignedOnly]);
    const viewing = catalog?.items.find(model => model.id === viewId);
    const mutate = async (model: ICatalogModel, action: 'assign' | 'remove'): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current || loading || loadError || !catalog) return;
        if (action === 'assign' && (!projectId || !canManage) || action === 'remove' && !isMain) return;
        lock.current = true; setBusy(model.id); setError('');
        try {
            const result = action === 'remove' ? await modelCatalogApi.remove(model)
                : assigned.has(model.id) ? await modelCatalogApi.unassign(projectId!, model.id) : await modelCatalogApi.assign(projectId!, model.id);
            if (result.ok !== true) throw new Error('Сервер не подтвердил изменение каталога моделей.');
            if (!owns()) return;
            if (action === 'remove') setViewId(null);
            await refresh();
        } catch (cause) {
            if (owns()) setError(errorMessage(cause, 'Не удалось изменить каталог моделей. Повторите попытку.'));
        } finally {
            lock.current = false;
            if (owns()) setBusy(null);
        }
    };
    return <div className="model-catalog">
        <div className="model-catalog__heading">
            <div><Typography.Title level={4}>Модели{projectName ? ` для «${projectName}»` : ''}</Typography.Title>
                <Typography.Paragraph type="secondary">{isMain ? 'Добавьте модель в каталог проекта и запустите её на сервере Нейроцентра.'
                    : canManage ? 'Выберите модели для проекта. Хостингом управляет главный администратор.'
                        : 'Модели, доступные команде проекта. Хостингом управляет главный администратор.'}</Typography.Paragraph></div>
            {isMain && <Button type="primary" onClick={() => setEditing('new')}>Добавить модель</Button>}
        </div>
        <Alert showIcon type="info" className="model-catalog__notice" message="Один хостинг для команды"
            description="Модель добавляется в проект отдельно от запуска. Веса хранятся на сервере; установка моста для хостинга не требуется." />
        <Space wrap className="model-catalog__filters">
            <Input.Search aria-label="Поиск моделей" placeholder="Название, модель или назначение…" allowClear value={query} onChange={event => setQuery(event.target.value)} />
            {projectId && canManage && <Checkbox checked={assignedOnly} onChange={event => setAssignedOnly(event.target.checked)}>Только в каталоге проекта</Checkbox>}
            <Button loading={loading} disabled={!!busy} onClick={() => { void refresh(); }}>Обновить каталог</Button>
        </Space>
        {loadError && <Alert className="model-catalog__notice" type={catalog ? 'warning' : 'error'} showIcon message={catalog ? 'Не удалось обновить модели — показаны предыдущие данные' : 'Каталог моделей не загружен'}
            description={loadError} action={<Button loading={loading} onClick={() => { void refresh(); }}>Повторить</Button>} />}
        {error && !viewing && <Alert showIcon type="error" message={error} className="model-catalog__notice" />}
        {!catalog && loading ? <Spin className="model-catalog__loading" /> : catalog && (shown.length ? <Row gutter={[16, 16]} align="stretch">
            {shown.map(model => <Col key={model.id} xs={24} lg={12} xxl={8}>
                <ModelCard model={model} assigned={assigned.has(model.id)} projectSelected={!!projectId} canAssign={canManage && !loadError && !loading}
                    canHost={isMain} busy={busy === model.id} onAssign={() => { void mutate(model, 'assign'); }} onView={() => { setError(''); setViewId(model.id); }} />
            </Col>)}
        </Row> : <Empty description={query ? 'По этому запросу модели не найдены' : assignedOnly && projectId ? 'В проект пока не добавлены модели' : 'Пока нет доступных моделей'}>
            {(query || assignedOnly && canManage) && <Button onClick={() => { setQuery(''); setAssignedOnly(false); }}>Показать все модели</Button>}
        </Empty>)}
        {viewing && <ModelDetails model={viewing} canManage={isMain} busy={!!busy} error={error} onClose={() => { if (!lock.current) setViewId(null); }}
            onEdit={() => { setEditing(viewing); setViewId(null); }} onRemove={() => { void mutate(viewing, 'remove'); }} />}
        {isMain && editing && <ModelEditModal key={editing === 'new' ? 'new' : editing.id + ':' + editing.revision} model={editing === 'new' ? undefined : editing}
            onClose={() => setEditing(null)} onSaved={async () => {
                if (editing === 'new') { setQuery(''); setAssignedOnly(false); }
                await refresh();
            }} />}
    </div>;
}
