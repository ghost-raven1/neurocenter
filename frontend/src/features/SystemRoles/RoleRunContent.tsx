import { Alert, Descriptions, List, Space, Tag, Typography } from 'antd';
import { diagnosticNames, roleCallBudget, roleName, type RoleRun } from './types';
import { IndexerOwnerActions } from './IndexerOwnerActions';
import { RoleDelegations } from './RoleDelegations';
import { RoleFindingEvidence, RoleProjectContextReceiptView } from './RoleProjectContext';
import {RoleAnswer} from './RoleGuidance';
const phases: Record<string, string> = { queued: 'В очереди', collecting: 'Собирает измерения', validating_context: 'Проверяет контекст', model_step: 'Обращается к модели', delegating: 'Собирает ответы системных агентов', awaiting_review: 'Ожидает проверки', applying: 'Применяет', rolling_back: 'Откатывает', completed: 'Завершено', applied: 'Сохранено владельцами', rolled_back: 'Откат подтверждён', cancelled: 'Отменено', failed: 'Не завершено', interrupted: 'Прервано', unconfirmed: 'Применение не подтверждено' };
export const rolePhaseLabel = (phase: string): string => phases[phase] ?? 'Обновляет состояние';

/** Measured facts stay separate from interpretation; proposals show the exact selected version and full replacement. */
export function RoleRunContent({ run, showAnswer = true }: { run: RoleRun; showAnswer?: boolean }): JSX.Element {
    return <div className="system-role__result">
        <Space wrap><Typography.Text strong>{roleName(run.agentId)}</Typography.Text><Tag>{rolePhaseLabel(run.phase)}</Tag><Typography.Text type="secondary">Зарезервировано шагов модели: {run.callsStarted} / {run.modelCallBudget ?? roleCallBudget(run.agentId)}</Typography.Text></Space>
        <Alert showIcon type={['failed', 'interrupted'].includes(run.state) ? 'warning' : 'info'} message={run.message} />
        {run.agentId === 'agent-indexer' && <IndexerOwnerActions projectId={run.projectId} />}
        <details><summary>Модель и операция</summary><Descriptions size="small" column={1}><Descriptions.Item label="Операция"><Typography.Text copyable>{run.operationId}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="Модель"><Typography.Text>{run.modelId}</Typography.Text></Descriptions.Item><Descriptions.Item label="Точный pin"><Typography.Text copyable>{run.modelPin}</Typography.Text></Descriptions.Item></Descriptions></details>
        {!!run.facts.length && <><Typography.Title level={5}>Измерения системы</Typography.Title>{run.facts.map(fact => <details key={fact.id}><summary>{diagnosticNames[fact.kind]} · {fact.status === 'measured' ? 'измерено' : 'недоступно'} · {new Date(fact.checkedAt).toLocaleString('ru-RU')}</summary><pre>{JSON.stringify(fact.data, null, 2)}</pre><Typography.Text type="secondary">ID измерения: {fact.id}</Typography.Text></details>)}</>}
        {run.result && <>{showAnswer && <><Typography.Title level={5}>Объяснение агента</Typography.Title><RoleAnswer result={run.result} /></>}
            <List size="small" dataSource={run.result.findings} renderItem={item => <List.Item><div>{item.detail}<div><RoleFindingEvidence evidenceId={item.evidenceId} context={run.result?.projectContext} guidance={run.result?.guidance} diagnosticIds={run.facts.map(fact => fact.id)} /></div></div></List.Item>} />
            <RoleProjectContextReceiptView context={run.result.projectContext} />
            {!!run.result.nextSteps.length && <ul>{run.result.nextSteps.map((step, index) => <li key={index}>{step}</li>)}</ul>}
            {run.result.changes.map(change => { const target = run.targets.find(item => item.key === change.targetKey); return <section key={change.targetKey}>
                <Typography.Title level={5}>{target?.id} · версия {target?.version}</Typography.Title><Typography.Paragraph>{change.explanation}</Typography.Paragraph>
                {target?.kind === 'plugin-settings' && <Alert showIcon type="info" message="Меняется только описание плагина. Файлы, код, зависимости и локальные настройки применяются их владельцами отдельно." />}
                {target && !target.editable && <Alert showIcon type="info" message="Готовый текст можно скопировать и применить в исходном редакторе. Автоматическое применение этой цели недоступно." />}
                <div className="system-role__diff"><div><Typography.Text strong>До · v{target?.version}</Typography.Text><pre>{target?.content}</pre></div><div><Typography.Text strong>Предложение</Typography.Text><pre>{change.replacement}</pre><Typography.Paragraph copyable={{ text: change.replacement }}>Скопировать предложение</Typography.Paragraph></div></div>
            </section>; })}</>}
        {!!run.result?.delegations?.length && <RoleDelegations delegations={run.result.delegations} diagnosticIds={run.facts.map(fact => fact.id)} />}
        {!!run.applied.length && <Alert type="success" showIcon message="Подтверждённые версии владельцев" description={run.applied.map(item => `${item.targetKey}: v${item.version}`).join('; ')} />}
        <details><summary>Этапы операции</summary><ul>{run.steps.map((step, index) => <li key={index}>{new Date(step.at).toLocaleTimeString('ru-RU')} · {step.message}</li>)}</ul></details>
    </div>;
}
