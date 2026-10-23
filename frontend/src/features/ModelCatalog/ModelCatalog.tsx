import {ProviderSetupModal} from '../OpenCodeProviders/ProviderSetupModal';
import {providerModelEligible} from '../OpenCodeProviders/model';
import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import {useEmbeddingTarget,EmbeddingTargetFields} from '../ProjectEmbedding/EmbeddingTarget';
import { Alert, Button, Checkbox, Col, Empty, Input, Row, Space, Spin, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { eligibleEmbedding } from '../ProjectEmbedding/model';
import { useProjectReindex } from '../ProjectEmbedding/useProjectReindex';
import { ProjectReindexStatus } from '../ProjectEmbedding/ProjectReindexStatus';
import { modelCatalogApi } from './api';
import { ModelCard } from './ModelCard';
import {CatalogFeedback} from '../Discussions';
import { ModelDetails } from './ModelDetails';
import { ModelEditModal } from './ModelEditModal';
import { RemoteConnectionModal } from './RemoteConnectionModal';
import { OpenCodeImportModal } from './OpenCodeImportModal';
import { ModelChatModal } from '../ModelChat/ModelChatModal';
import { modelChatUnavailableReason } from '../ModelChat/model';
import { filterCatalogModels } from './modelCatalogState';
import type { ICatalogModel, IRemoteConnectionHint } from './types';
import { useModelCatalog } from './useModelCatalog';
import './ModelCatalog.less';
import {projectRagCatalogUrl} from '../../modules/Projects/projectNavigation';

export interface IModelCatalogProps {
    projectId?: string;
    projectName?: string;
    embedded?: boolean;
    canManage: boolean;
    isMain: boolean;
    canChat?: boolean;
}

/** Проект получает право на модель; веса и общий хостинг не копируются в каждый проект. */
export function ModelCatalog({ projectId, projectName, embedded, canManage, isMain, canChat = isMain }: IModelCatalogProps): JSX.Element {
    const { scope, captureOwner } = useAuthRequestOwner();
    const { catalog, loading, error: loadError, refresh } = useModelCatalog(projectId);
    const embeddingTarget=useEmbeddingTarget(projectId);
    const reindex = useProjectReindex(projectId, () => { void refresh(); });
    const [query, setQuery] = useState('');
    const [assignedOnly, setAssignedOnly] = useState(!!embedded);
    const [viewId, setViewId] = useState<string | null>(null);
    const [editing, setEditing] = useState<ICatalogModel | 'new' | 'api' | null>(null);
    const [connection, setConnection] = useState<ICatalogModel | null>(null);
    const [importing, setImporting] = useState(false);
    const [providerSetup, setProviderSetup] = useState<{scope: string; modelId?: string}>();
    const [chatId, setChatId] = useState<string | null>(null);
    const [connectionHint, setConnectionHint] = useState<IRemoteConnectionHint>();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');
    const formScope = JSON.stringify([scope, projectId]), previousScope = useRef(formScope);
    useEffect(() => {
        if (previousScope.current === formScope) return;
        previousScope.current = formScope;
        setProviderSetup(undefined); setViewId(null); setEditing(null); setConnection(null); setImporting(false); setChatId(null); setConnectionHint(undefined); setError(''); setBusy(null);
    }, [formScope]);
    const openProvider = (modelId?: string): void => {
        if (captureOwner()() && previousScope.current === formScope && projectId && canManage) setProviderSetup({scope: formScope, modelId});
    };
    const lock = useRef(false);
    const assigned = useMemo(() => new Set(catalog?.assignedModelIds ?? []), [catalog]);
    const shown = useMemo(() => catalog ? filterCatalogModels(catalog, query, !!projectId && assignedOnly) : [], [catalog, query, projectId, assignedOnly]);
    const viewing = catalog?.items.find(model => model.id === viewId);
    const chatting = catalog?.items.find(model => model.id === chatId);
    useEffect(() => {
        if (!chatId || !catalog) return;
        if (!chatting || !canChat || !!projectId && !assigned.has(chatId)) {
            setChatId(null); setError('Чат закрыт: модель больше недоступна в текущем профиле или проекте.');
        }
    }, [chatId, catalog, chatting, canChat, projectId, assigned]);
    const archived = (): void => { setViewId(null); void refresh(); };
    const prepareEmbedding=!!projectId&&embeddingTarget.mode==='computer'&&embeddingTarget.blocker==='installation'&&embeddingTarget.blocked
        &&!loading&&!loadError&&!busy&&!reindex.pending&&!reindex.busy&&reindex.plan?.state!=='needs_input';
    const assignmentReason=(model:ICatalogModel,connecting=false):string=>{
        if(loading)return 'Дождитесь загрузки актуального каталога моделей.';
        if(loadError)return 'Обновите каталог моделей перед изменением проекта.';
        if(busy)return 'Дождитесь завершения изменения каталога моделей.';
        if(reindex.plan?.state==='needs_input')return 'Подтвердите или отмените подготовленную смену модели.';
        if(reindex.pending||reindex.busy)return 'Дождитесь завершения подключения модели и переиндексации.';
        return (connecting||!assigned.has(model.id))&&eligibleEmbedding(model)&&embeddingTarget.blocked
            ?embeddingTarget.reason||'Выберите, куда подключить модель: сервер или конкретную установку OpenCodeRAG.':'';
    };
    const connect = async (model:ICatalogModel):Promise<void>=>{
        const owns=captureOwner();
        if(!owns()||lock.current||loading||loadError||!catalog||reindex.pending||reindex.busy||reindex.plan?.state==='needs_input')return;
        if(!projectId||!canManage||!assigned.has(model.id)||!eligibleEmbedding(model)||model.archivedAt||embeddingTarget.blocked)return;
        lock.current=true;setBusy(model.id);setError('');
        try{await reindex.request(model,undefined,embeddingTarget.value);}
        catch(cause){if(owns())setError(errorMessage(cause,'Не удалось подготовить подключение модели. Повторите попытку.'));}
        finally{lock.current=false;if(owns())setBusy(null);}
    };
    const mutate = async (model: ICatalogModel): Promise<void> => {
        const owns = captureOwner();
        if (!owns() || lock.current || loading || loadError || !catalog || reindex.pending || reindex.busy || reindex.plan?.state==='needs_input') return;
        if (!projectId || !canManage) return;
        lock.current = true; setBusy(model.id); setError('');
        try {
            const adding = !assigned.has(model.id);
            if(adding&&eligibleEmbedding(model)&&embeddingTarget.blocked)throw new Error('Выберите, куда подключить модель: сервер или конкретную установку OpenCodeRAG.');
            const result = adding ? await modelCatalogApi.assign(projectId, model.id) : await modelCatalogApi.unassign(projectId, model.id);
            if (result.ok !== true) throw new Error('Сервер не подтвердил изменение каталога моделей.');
            if (!owns()) return;
            if (adding && eligibleEmbedding(model)) await reindex.request(model,undefined,embeddingTarget.value);
            if (!owns()) return;
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
            <div><Typography.Title level={4}>{projectName ? `Модели для «${projectName}»` : 'Модели команды'}</Typography.Title>
                <Typography.Text type="secondary">{projectId ? 'Выберите модели для работы в проекте.' : 'Модели на сервере и подключённые API.'}</Typography.Text></div>
            {(isMain || projectId && canManage) && <Space wrap>
                {projectId && canManage && <Button onClick={() => openProvider()}>Настроить в OpenCode</Button>}
                {isMain && <><Tooltip title="Общая конфигурация компьютера или настройки проекта"><FeatureButton features={['opencode_model_sync']} onClick={() => setImporting(true)}>Из OpenCode</FeatureButton></Tooltip>
                <FeatureButton features={['model_catalog']} onClick={() => setEditing('api')}>Подключить API</FeatureButton>
                <FeatureButton features={['model_catalog']} type="primary" onClick={() => setEditing('new')}>Добавить модель</FeatureButton></>}</Space>}
        </div>
        <Space wrap className="model-catalog__filters">
            <Input.Search aria-label="Поиск моделей" placeholder="Название, модель или назначение…" allowClear value={query} onChange={event => setQuery(event.target.value)} />
            {projectId && canManage && <Checkbox checked={assignedOnly} onChange={event => setAssignedOnly(event.target.checked)}>Только в каталоге проекта</Checkbox>}
            <Button loading={loading} disabled={!!busy} onClick={() => { void refresh(); }}>Обновить</Button>
        </Space>
        {loadError && <Alert className="model-catalog__notice" type={catalog ? 'warning' : 'error'} showIcon message={catalog ? 'Не удалось обновить модели — показаны предыдущие данные' : 'Каталог моделей не загружен'}
            description={loadError} action={<Button loading={loading} onClick={() => { void refresh(); }}>Повторить</Button>} />}
        {error && !viewing && <Alert showIcon type="error" message={error} className="model-catalog__notice" />}
        {projectId&&<div className="model-catalog__embedding-target">
            {canManage&&<EmbeddingTargetFields target={embeddingTarget} disabled={reindex.busy||reindex.pending}/>}
            <ProjectReindexStatus state={reindex} canManage={canManage && !loadError && !loading} />
        </div>}
        {!catalog && loading ? <div role="status" aria-live="polite" className="model-catalog__loading"><Spin tip="Загружаем модели…" /></div> : catalog && (shown.length ? <Row gutter={[16, 16]} align="stretch">
            {shown.map(model => <Col key={model.id} xs={24} xl={12}>
                <ModelCard model={model} assigned={assigned.has(model.id)} projectSelected={!!projectId} canAssign={canManage} assignmentUnavailableReason={assignmentReason(model)} feedback={<CatalogFeedback catalogId={'model:' + model.id} title={model.name}/>}
                    embeddingSetupHref={prepareEmbedding?projectRagCatalogUrl(projectId!):undefined}
                    canHost={isMain} busy={busy === model.id} disabled={!!busy || !!loadError || loading} onAssign={() => { void mutate(model); }} onView={() => { setError(''); setViewId(model.id); }}
                    onConnect={()=>{void connect(model);}} connectionUnavailableReason={assignmentReason(model,true)}
                    onEdit={() => setEditing(model)} onRemove={archived} onConfigure={() => setConnection(model)}
                    onSetupProvider={providerModelEligible(model) ? () => openProvider(model.id) : undefined}
                    onChat={() => setChatId(model.id)} chatUnavailableReason={modelChatUnavailableReason(model, canChat, !!projectId, assigned.has(model.id))} />
            </Col>)}
        </Row> : <Empty description={query ? 'По этому запросу модели не найдены' : assignedOnly && projectId ? 'В проект пока не добавлены модели' : 'Пока нет доступных моделей'}>
            {(query || assignedOnly && canManage) && <Button onClick={() => { setQuery(''); setAssignedOnly(false); }}>Показать все модели</Button>}
        </Empty>)}
        {viewing && <ModelDetails model={viewing} projectId={projectId} canManage={isMain && !loadError && !loading} busy={!!busy} error={error} onClose={() => { if (!lock.current) setViewId(null); }}
            onEdit={() => { setEditing(viewing); setViewId(null); }} onRemove={archived} onConfigure={() => { setConnection(viewing); setViewId(null); }} />}
        {isMain && editing && <ModelEditModal key={typeof editing === 'string' ? editing : editing.id + ':' + editing.revision} model={typeof editing === 'string' ? undefined : editing} connectApi={editing === 'api'}
            onClose={() => setEditing(null)} onSaved={async saved => {
                const owns = captureOwner(); if (!owns()) return;
                if (typeof editing === 'string') { setQuery(''); setAssignedOnly(false); }
                await refresh(); if (!owns()) return;
                if (saved && saved.runtime !== 'ollama' && !saved.verificationSha256) setConnection(saved);
            }} />}
        {isMain && connection && <RemoteConnectionModal key={`${connection.id}:${connection.revision}`} model={connection} hint={connectionHint} onClose={() => { setConnection(null); setConnectionHint(undefined); }} onSaved={refresh} />}
        {chatting && canChat && (!projectId || assigned.has(chatting.id)) && <ModelChatModal key={JSON.stringify([scope, projectId, chatting.id])} model={chatting} projectId={projectId} projectName={projectName}
            unavailableReason={loading ? 'Дождитесь обновления каталога перед следующим запросом.' : loadError ? 'Обновите каталог перед следующим запросом.'
                : modelChatUnavailableReason(chatting, canChat, !!projectId, assigned.has(chatting.id))} onClose={() => setChatId(null)} />}
        {projectId && canManage && providerSetup?.scope === formScope && <ProviderSetupModal key={formScope} bridge={embeddingTarget.bridge} projectId={projectId} projectName={projectName}
            models={catalog?.items.filter(model => assigned.has(model.id)) ?? []} initialModelId={providerSetup.modelId} canManage={canManage} canPrepareConnector={isMain}
            catalogReady={!!catalog && !loading && !loadError} catalogError={loadError} onReloadModels={() => {void refresh();}} onClose={() => {if (captureOwner()()) setProviderSetup(current => current === providerSetup ? undefined : current);}} />}
        {isMain && importing && <OpenCodeImportModal key={`${scope}:${projectId||'common'}`} projectId={projectId} onClose={() => setImporting(false)} onImported={async (model, hint) => {
            const owns = captureOwner(); if (!owns()) return; await refresh(); if (!owns()) return; setImporting(false); setConnectionHint(hint); setConnection(model);
        }} />}
    </div>;
}
