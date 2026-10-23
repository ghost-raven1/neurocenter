import {SystemRoles} from '../SystemRoles/SystemRoles';
import {ProjectConfiguration} from '../ProjectConfiguration/ProjectConfiguration';
import {ProjectProviderSetup} from '../OpenCodeProviders/ProjectProviderSetup';
import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, Checkbox, Col, Empty, Input, Modal, Row, Space, Spin, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { BridgeConnection } from '../McpBridge/BridgeConnection';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { AgentCard } from './AgentCard';
import {CatalogFeedback} from '../Discussions';
import { AgentDetails } from './AgentDetails';
import { AgentEditModal } from './AgentEditModal';
import { ProjectAgentEditor } from './ProjectAgentEditor';
import { agentConnection, projectAgentStatus, selectedAgentTarget, visibleAgents } from './model';
import { useAgentActions } from './useAgentActions';
import { useAgentCatalog } from './useAgentCatalog';
import type { IAgentCatalogProps, IProjectAgent, ICatalogAgent } from './types';
import './AgentCatalog.less';
import {openModelChat} from '../ModelChat/chatNavigation';
import {projectRoleLevel} from '../UserBlock/roles';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import { useAgentReadiness } from './useAgentReadiness';
import { AgentTrialModal } from './AgentTrialModal';

/** Common templates, immutable project pins and actual bridge delivery share one visible flow. */
export function AgentCatalog(props: IAgentCatalogProps): JSX.Element {
    const { projectId, projectName, embedded, canManage, isMain, bridge } = props;
    const user=useSelector((state:RootState)=>state.userBlock.user);
    const { scope, captureOwner } = useAuthRequestOwner(), history = useHistory();
    const { catalog, loading, error, refresh } = useAgentCatalog(projectId);
    const canReadTrials = !!projectId && projectRoleLevel(user, projectId) >= 2;
    const readiness = useAgentReadiness(projectId, canReadTrials, catalog?.revision ?? null);
    const actions = useAgentActions({ ...props, catalog, refresh });
    const [query, setQuery] = useState(''), [projectOnly, setProjectOnly] = useState(!!embedded);
    const [showArchive, setShowArchive] = useState(false);
    const [editing, setEditing] = useState<ICatalogAgent | 'new'>(), [viewId, setViewId] = useState<string>();
    const [projectEditing, setProjectEditing] = useState<{assignment: IProjectAgent; revision: number}>();
    const [trialAgentId, setTrialAgentId] = useState<string>();
    const providerScope = JSON.stringify([scope, projectId]);
    const [providerSetup, setProviderSetup] = useState<{scope: string}>();
    const confirmation = useRef<{destroy(): void}>();
    useEffect(() => { setEditing(undefined); setViewId(undefined); setProjectEditing(undefined); setTrialAgentId(undefined); setProviderSetup(undefined); setQuery(''); setProjectOnly(!!embedded); setShowArchive(false); return () => confirmation.current?.destroy(); }, [scope, projectId, embedded]);
    const assignments = useMemo(() => new Map(catalog?.assignments.map(item => [item.agentId, item]) ?? []), [catalog]);
    const shown = useMemo(() => catalog ? visibleAgents(catalog, query, !!projectId && projectOnly, isMain && showArchive) : [], [catalog, query, projectId, projectOnly, isMain, showArchive]);
    const connection = agentConnection(props);
    const target = selectedAgentTarget(props);
    const unavailable = loading || !!error || !catalog || actions.unconfirmed;
    const pending = !!catalog?.deliveries.some(item => connection.target && item.deviceId === connection.target.deviceId
        && item.bindingId === connection.target.expectedBindingId && item.instanceId === connection.target.expectedInstanceId
        && item.revision === catalog.revision && ['queued', 'running', 'reconciling'].includes(item.state));
    const viewing = catalog && (catalog.items.find(item => item.id === viewId) ?? assignments.get(viewId ?? '')?.card);
    const trialItem = readiness.items.find(item => item.agentId === trialAgentId);
    const trialAssignment = assignments.get(trialAgentId ?? '');
    const checkingTrial = (agentId: string): boolean => !catalog || catalog.revision === null
        || readiness.items.find(item => item.agentId === agentId)?.projectRevision !== catalog.revision;
    const cleanup = catalog?.assignments.filter(item => item.removed && projectAgentStatus(catalog, item, target).key !== 'removed') ?? [];
    const perform = (kind: 'assign' | 'configure' | 'remove', agent: ICatalogAgent, patch?: Parameters<typeof actions.mutate>[0]['patch']): void => {
        if (unavailable || !catalog || catalog.revision === null) return;
        void actions.mutate({ kind, agent, revision: catalog.revision, patch }).catch(() => undefined);
    };
    const remove = (assignment: IProjectAgent): void => {
        confirmation.current = Modal.confirm({ title: `Удалить «${assignment.card.name}» из проекта?`,
            content: 'Агент будет отключён и удалён из управляемых настроек выбранной папки OpenCode через мост. При недоступном компьютере удаление останется ожидающим. Общий шаблон и другие проекты сохранятся.',
            okText: 'Удалить из проекта', cancelText: 'Отмена', okButtonProps: { danger: true },
            onOk: () => { if (catalog?.revision !== null && catalog) return actions.mutate({ kind: 'remove', agent: assignment.card, revision: catalog.revision }).then(() => undefined).catch(() => undefined); },
        });
    };
    const update = (agent: ICatalogAgent, assignment: IProjectAgent): void => {
        confirmation.current = Modal.confirm({ title: `Обновить шаблон v${assignment.version} → v${agent.version}?`,
            content: 'Ваши переопределения промпта и параметров сохранятся. Остальные настройки будут взяты из новой версии и отправлены выбранному компьютеру, если мост доступен.',
            okText: 'Обновить шаблон', cancelText: 'Отмена', onOk: () => { perform('configure', assignment.card, { version: agent.version, manifest: agent.manifest }); },
        });
    };
    const saved = async (): Promise<void> => { if (!await refresh()) throw new Error('Агент сохранён, но каталог не обновился. Ваш текст остался в форме; повтор безопасен.'); setProjectOnly(false); setQuery(''); };
    return <section className="agent-catalog">
        <div className="agent-catalog__heading"><div><Typography.Title level={4}>{projectName ? `Агенты для «${projectName}»` : 'Агенты команды'}</Typography.Title>
            <Typography.Text type="secondary">{projectId ? 'Настройте промпты проекта и примените их к выбранной папке OpenCode.' : 'Готовые роли и собственные промпты для OpenCode.'}</Typography.Text></div>
        </div>
        {(isMain || projectId && canManage) && <SystemRoles key={JSON.stringify([scope, projectId])} projectId={projectId} />}
        <div className="agent-catalog__toolbar"><Input.Search aria-label="Поиск агентов" placeholder="Название, роль или имя OpenCode…" allowClear value={query} onChange={event => setQuery(event.target.value)} />
            <div className="agent-catalog__filters">
            {projectId && <Checkbox checked={projectOnly} onChange={event => setProjectOnly(event.target.checked)}>Только в проекте</Checkbox>}
            {isMain && <Checkbox checked={showArchive} onChange={event => setShowArchive(event.target.checked)}>Показывать архив</Checkbox>}</div>
            <Space wrap className="agent-catalog__toolbar-actions"><Button loading={loading} disabled={actions.busy} onClick={() => { void refresh(); }}>Обновить</Button>
                {projectId&&projectRoleLevel(user,projectId)>=2&&<Button onClick={()=>openModelChat({projectId,group:true})}>Чат с агентами</Button>}
                {isMain&&<><Button onClick={() => history.push('/assets')}>Из ассетов</Button><FeatureButton features={['agents']} type="primary" disabled={loading || !!error} onClick={() => setEditing('new')}>Добавить агента</FeatureButton></>}
            </Space>
        </div>
        {error && <Alert showIcon type={catalog ? 'warning' : 'error'} className="agent-catalog__notice" message={catalog ? 'Не удалось обновить агентов — показаны предыдущие данные' : 'Агенты не загружены'} description={error} action={<Button onClick={() => { void refresh(); }}>Повторить</Button>} />}
        {actions.error && <Alert showIcon type="error" className="agent-catalog__notice" message={actions.error} action={actions.unconfirmed && <Space wrap><Button disabled={actions.busy} onClick={() => { void actions.repeat(); }}>Повторить запрос</Button><Button disabled={actions.busy} onClick={() => { void actions.recheck(); }}>Перечитать состояние</Button></Space>} />}
        {actions.notice && <Alert showIcon type="info" className="agent-catalog__notice" message={actions.notice} />}
        {canReadTrials && readiness.error && !trialAgentId && <Alert type="warning" showIcon className="agent-catalog__notice" message="Состояние испытаний не обновилось" description={readiness.error}
            action={<Button loading={readiness.loading} onClick={() => { void readiness.refresh(); }}>Перечитать испытания</Button>} />}
        {projectId && <div className="agent-catalog__connection"><BridgeConnection bridge={bridge} compact showReadinessNotice={false} />
            <div className="agent-catalog__apply"><div><Typography.Text strong>Настройки OpenCode</Typography.Text><Typography.Paragraph type="secondary">{connection.reason || 'Применяем только управляемые файлы агентов. Изменения появятся при следующем запуске OpenCode.'}</Typography.Paragraph></div>
                {canManage && <Button onClick={() => {if (captureOwner()()) setProviderSetup({scope: providerScope});}}>Настроить провайдера</Button>}
                {canManage && <Tooltip title={catalog?.revision === 0 ? 'Сначала добавьте агента в проект.' : connection.reason}><span><FeatureButton features={catalog?.assignments.some(item=>!item.removed&&item.enabled) ? ['agents'] : []} type="primary" disabled={unavailable || !catalog?.revision || !connection.target || pending} loading={actions.busy || pending} onClick={() => { void actions.apply(); }}>Применить настройки</FeatureButton></span></Tooltip>}
            </div><ProjectConfiguration projectId={projectId} bridge={bridge}/></div>}
        {!!cleanup.length && <Alert className="agent-catalog__notice" type="warning" showIcon message={`Ожидают удаления из OpenCode: ${cleanup.map(item => item.card.name).join(', ')}`}
            description="Удаление сохранено в проекте. Нажмите «Применить настройки» для выбранного компьютера. В других связанных папках также потребуется применение." />}
        {!catalog && loading ? <div className="agent-catalog__loading" role="status"><Spin tip="Загружаем агентов…" /></div> : catalog && (shown.length ? <Row gutter={[16, 16]} align="stretch">{shown.map(agent => {
            const assignment = assignments.get(agent.id), status = assignment ? projectAgentStatus(catalog, assignment, target) : undefined;
            const trial = readiness.items.find(item => item.agentId === agent.id);
            return <Col xs={24} xl={12} key={agent.id}><AgentCard agent={agent} assignment={assignment} status={status} isMain={isMain} canManage={canManage} projectSelected={!!projectId} feedback={<CatalogFeedback catalogId={'agent:' + agent.id} title={agent.name}/>}
                readiness={trial} trialChecking={checkingTrial(agent.id)} trialDisabled={!trial || actions.busy} onTrial={canReadTrials && assignment && !assignment.removed ? () => setTrialAgentId(agent.id) : undefined}
                busy={actions.busy} unavailable={unavailable} onView={() => setViewId(agent.id)} onEdit={() => setEditing(agent)} onArchived={() => { void refresh(); }}
                onAssign={() => perform('assign', assignment?.removed ? assignment.card : agent)}
                onConfigure={() => { if (assignment && catalog.revision !== null) setProjectEditing({ assignment, revision: catalog.revision }); }}
                onToggle={() => { if (assignment) perform('configure', assignment.card, { enabled: !assignment.enabled }); }}
                onRemove={() => { if (assignment) remove(assignment); }} onUpdate={() => { if (assignment) update(agent, assignment); }} /></Col>;
        })}</Row> : <Empty description={query ? 'По этому запросу агенты не найдены' : projectOnly && projectId ? 'В проект пока не добавлены агенты' : 'В каталоге пока нет агентов'}>
            {(query || projectOnly) && <Button onClick={() => { setQuery(''); setProjectOnly(false); }}>Показать все агенты</Button>}
        </Empty>)}
        {viewing && <AgentDetails agent={viewing} assignment={assignments.get(viewing.id)} onClose={() => setViewId(undefined)}
            readiness={readiness.items.find(item => item.agentId === viewing.id)} trialChecking={checkingTrial(viewing.id)} onTrial={canReadTrials && readiness.items.some(item => item.agentId === viewing.id)
                ? () => { setViewId(undefined); setTrialAgentId(viewing.id); } : undefined} />}
        {projectId && canManage && providerSetup?.scope === providerScope && <ProjectProviderSetup key={JSON.stringify([scope, projectId])} projectId={projectId} projectName={projectName} bridge={bridge} canManage={canManage} canPrepareConnector={isMain} onClose={() => {if (captureOwner()()) setProviderSetup(current => current === providerSetup ? undefined : current);}} />}
        {isMain && editing && <AgentEditModal key={editing === 'new' ? 'new' : editing.id + ':' + editing.version} agent={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={saved} />}
        {canManage && projectId && projectEditing && <ProjectAgentEditor key={projectEditing.assignment.agentId + ':' + projectEditing.revision} projectId={projectId} {...projectEditing} onClose={() => setProjectEditing(undefined)}
            onSave={(agent, patch, revision) => actions.mutate({ kind: 'configure', agent, patch, revision })} />}
        {canReadTrials && projectId && trialItem && trialAssignment && <AgentTrialModal key={scope + ':' + projectId + ':' + trialItem.agentId} projectId={projectId} name={trialAssignment.card.name} item={trialItem}
            busy={readiness.busy} loading={readiness.loading} checking={checkingTrial(trialItem.agentId)} error={readiness.error} uncertain={readiness.uncertain} onClose={() => setTrialAgentId(undefined)}
            onRefresh={() => { void readiness.refresh(); }} onReplay={() => { void readiness.replay(); }} onStart={(modelId, tool, consent) => { void readiness.start(trialItem, modelId, tool, consent); }}
            onCancel={trial => { void readiness.cancel(trialItem.agentId, trial); }} />}
    </section>;
}
