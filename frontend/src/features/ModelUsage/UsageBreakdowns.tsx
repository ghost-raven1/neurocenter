import {Card, Empty, List, Tabs, Typography} from 'antd';
import type {ReactNode} from 'react';
import {endpointLabels, purposeLabels, usageActor, usageCount, usageLatency, usageProject} from './presentation';
import type {UsageReport, UsageTotals} from './types';

function Breakdown({rows}: {rows: Array<{key: string; title: string; totals: UsageTotals}>}): JSX.Element {
    return <List size="small" dataSource={rows} locale={{emptyText: <Empty description="За этот период операций нет"/>}} renderItem={row => <List.Item key={row.key} className="model-usage__breakdown-row"><Typography.Text strong>{row.title}</Typography.Text><div>
        <Typography.Text>{usageCount(row.totals.requests)} операций · {usageCount(row.totals.apiCalls)} обращений к API</Typography.Text>
        <Typography.Text type="secondary">Вход {usageCount(row.totals.inputTokens)} · Выход {usageCount(row.totals.outputTokens)} токенов · API на операцию {usageLatency(row.totals.averageProviderLatencyMs)}</Typography.Text>
    </div></List.Item>}/>;
}

/** The server aggregates the full filtered scope; visible page length is never used for totals. */
export function UsageBreakdowns({report}: {report: UsageReport}): JSX.Element {
    const items: Array<{key: string; label: string; children: ReactNode}> = [
        {key: 'users', label: 'Пользователи', children: <Breakdown rows={(report.byActor ?? []).map(row => ({key: row.actorEmail ?? '__system__', title: usageActor(row.displayName, row.actorEmail), totals: row}))}/>},
        {key: 'projects', label: 'Проекты', children: <Breakdown rows={(report.byProject ?? []).map(row => ({key: row.projectId ?? '__none__', title: usageProject(row.projectName, row.projectId), totals: row}))}/>},
        {key: 'models', label: 'Модели', children: <Breakdown rows={report.byModel.map(row => ({key: row.modelId, title: row.name, totals: row}))}/>},
        {key: 'agents', label: 'Агенты', children: <Breakdown rows={(report.byAgent ?? []).map(row => ({key: row.agentId ?? '__none__', title: row.agentName || (row.agentId ? 'Агент недоступен' : 'Без агента'), totals: row}))}/>},
        {key: 'purpose', label: 'Назначение', children: <Breakdown rows={report.byPurpose.map(row => ({key: row.purpose, title: purposeLabels[row.purpose], totals: row}))}/>},
        {key: 'endpoint', label: 'Тип API', children: <Breakdown rows={(report.byEndpoint ?? []).map(row => ({key: row.endpoint, title: endpointLabels[row.endpoint], totals: row}))}/>},
    ];
    return <Card title="Кто и как использует модели" size="small"><Tabs items={items}/></Card>;
}
