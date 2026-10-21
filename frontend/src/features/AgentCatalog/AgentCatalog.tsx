import { Alert, Button, Checkbox, Col, Empty, Input, Modal, Row, Space, Spin, Tooltip, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { BridgeConnection } from '../McpBridge/BridgeConnection';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { AgentCard } from './AgentCard';
import { AgentDetails } from './AgentDetails';
import { AgentEditModal } from './AgentEditModal';
import { ProjectAgentEditor } from './ProjectAgentEditor';
import { agentConnection, projectAgentStatus, selectedAgentTarget, visibleAgents } from './model';
import { useAgentActions } from './useAgentActions';
import { useAgentCatalog } from './useAgentCatalog';
import type { IAgentCatalogProps, IProjectAgent, ICatalogAgent } from './types';
import './AgentCatalog.less';

/** Common templates, immutable project pins and actual bridge delivery share one visible flow. */
export function AgentCatalog(props: IAgentCatalogProps): JSX.Element {
    const { projectId, projectName, embedded, canManage, isMain, bridge } = props;
    const { scope } = useAuthRequestOwner(), history = useHistory();
    const { catalog, loading, error, refresh } = useAgentCatalog(projectId);
    const actions = useAgentActions({ ...props, catalog, refresh });
    const [query, setQuery] = useState(''), [projectOnly, setProjectOnly] = useState(!!embedded);
    const [showArchive, setShowArchive] = useState(false);
    const [editing, setEditing] = useState<ICatalogAgent | 'new'>(), [viewId, setViewId] = useState<string>();
    const [projectEditing, setProjectEditing] = useState<{assignment: IProjectAgent; revision: number}>();
    const confirmation = useRef<{destroy(): void}>();
    useEffect(() => { setEditing(undefined); setViewId(undefined); setProjectEditing(undefined); setQuery(''); setProjectOnly(!!embedded); setShowArchive(false); return () => confirmation.current?.destroy(); }, [scope, projectId, embedded]);
    const assignments = useMemo(() => new Map(catalog?.assignments.map(item => [item.agentId, item]) ?? []), [catalog]);
    const shown = useMemo(() => catalog ? visibleAgents(catalog, query, !!projectId && projectOnly, isMain && showArchive) : [], [catalog, query, projectId, projectOnly, isMain, showArchive]);
    const connection = agentConnection(props);
    const target = selectedAgentTarget(props);
    const unavailable = loading || !!error || !catalog || actions.unconfirmed;
    const pending = !!catalog?.deliveries.some(item => connection.target && item.deviceId === connection.target.deviceId
        && item.bindingId === connection.target.expectedBindingId && item.instanceId === connection.target.expectedInstanceId
        && item.revision === catalog.revision && ['queued', 'running', 'reconciling'].includes(item.state));
    const viewing = catalog && (catalog.items.find(item => item.id === viewId) ?? assignments.get(viewId ?? '')?.card);
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
            {isMain && <Space wrap><Button onClick={() => history.push('/assets')}>Из ассетов</Button><Button type="primary" disabled={loading || !!error} onClick={() => setEditing('new')}>Добавить агента</Button></Space>}
        </div>
        <Space wrap className="agent-catalog__filters"><Input.Search aria-label="Поиск агентов" placeholder="Название, роль или имя OpenCode…" allowClear value={query} onChange={event => setQuery(event.target.value)} />
            {projectId && <Checkbox checked={projectOnly} onChange={event => setProjectOnly(event.target.checked)}>Только в проекте</Checkbox>}
            {isMain && <Checkbox checked={showArchive} onChange={event => setShowArchive(event.target.checked)}>Показывать архив</Checkbox>}<Button loading={loading} disabled={actions.busy} onClick={() => { void refresh(); }}>Обновить</Button></Space>
        {error && <Alert showIcon type={catalog ? 'warning' : 'error'} className="agent-catalog__notice" message={catalog ? 'Не удалось обновить агентов — показаны предыдущие данные' : 'Агенты не загружены'} description={error} action={<Button onClick={() => { void refresh(); }}>Повторить</Button>} />}
        {actions.error && <Alert showIcon type="error" className="agent-catalog__notice" message={actions.error} action={actions.unconfirmed && <Space wrap><Button disabled={actions.busy} onClick={() => { void actions.repeat(); }}>Повторить запрос</Button><Button disabled={actions.busy} onClick={() => { void actions.recheck(); }}>Перечитать состояние</Button></Space>} />}
        {actions.notice && <Alert showIcon type="info" className="agent-catalog__notice" message={actions.notice} />}
        {projectId && <div className="agent-catalog__connection"><BridgeConnection bridge={bridge} compact showReadinessNotice={false} />
            <div className="agent-catalog__apply"><div><Typography.Text strong>Настройки OpenCode</Typography.Text><Typography.Paragraph type="secondary">{connection.reason || 'Применяем только управляемые файлы агентов. Изменения появятся при следующем запуске OpenCode.'}</Typography.Paragraph></div>
                {canManage && <Tooltip title={catalog?.revision === 0 ? 'Сначала добавьте агента в проект.' : connection.reason}><span><Button type="primary" disabled={unavailable || !catalog?.revision || !connection.target || pending} loading={actions.busy || pending} onClick={() => { void actions.apply(); }}>Применить настройки</Button></span></Tooltip>}
            </div></div>}
        {!!cleanup.length && <Alert className="agent-catalog__notice" type="warning" showIcon message={`Ожидают удаления из OpenCode: ${cleanup.map(item => item.card.name).join(', ')}`}
            description="Удаление сохранено в проекте. Нажмите «Применить настройки» для выбранного компьютера. В других связанных папках также потребуется применение." />}
        {!catalog && loading ? <div className="agent-catalog__loading" role="status"><Spin tip="Загружаем агентов…" /></div> : catalog && (shown.length ? <Row gutter={[16, 16]} align="stretch">{shown.map(agent => {
            const assignment = assignments.get(agent.id), status = assignment ? projectAgentStatus(catalog, assignment, target) : undefined;
            return <Col xs={24} xl={12} key={agent.id}><AgentCard agent={agent} assignment={assignment} status={status} isMain={isMain} canManage={canManage} projectSelected={!!projectId}
                busy={actions.busy} unavailable={unavailable} onView={() => setViewId(agent.id)} onEdit={() => setEditing(agent)} onArchived={() => { void refresh(); }}
                onAssign={() => perform('assign', assignment?.removed ? assignment.card : agent)}
                onConfigure={() => { if (assignment && catalog.revision !== null) setProjectEditing({ assignment, revision: catalog.revision }); }}
                onToggle={() => { if (assignment) perform('configure', assignment.card, { enabled: !assignment.enabled }); }}
                onRemove={() => { if (assignment) remove(assignment); }} onUpdate={() => { if (assignment) update(agent, assignment); }} /></Col>;
        })}</Row> : <Empty description={query ? 'По этому запросу агенты не найдены' : projectOnly && projectId ? 'В проект пока не добавлены агенты' : 'В каталоге пока нет агентов'}>
            {(query || projectOnly) && <Button onClick={() => { setQuery(''); setProjectOnly(false); }}>Показать все агенты</Button>}
        </Empty>)}
        {viewing && <AgentDetails agent={viewing} assignment={assignments.get(viewing.id)} onClose={() => setViewId(undefined)} />}
        {isMain && editing && <AgentEditModal key={editing === 'new' ? 'new' : editing.id + ':' + editing.version} agent={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={saved} />}
        {canManage && projectId && projectEditing && <ProjectAgentEditor key={projectEditing.assignment.agentId + ':' + projectEditing.revision} projectId={projectId} {...projectEditing} onClose={() => setProjectEditing(undefined)}
            onSave={(agent, patch, revision) => actions.mutate({ kind: 'configure', agent, patch, revision })} />}
    </section>;
}
