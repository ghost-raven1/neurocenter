import {Button, Card, Descriptions, Empty, List, Space, Tag, Typography} from 'antd';
import {Link} from 'react-router-dom';
import {endpointLabels, protocolLabels, purposeLabels, statusLabels, usageActor, usageCount, usageFailure, usageLatency, usageProject} from './presentation';
import type {UsageItem, UsageReport} from './types';

function CallDetails({item}: {item: UsageItem}): JSX.Element {
    return <details className="model-usage__call-details"><summary>Подробности операции</summary><Descriptions size="small" column={1}>
        <Descriptions.Item label="Начало">{new Date(item.startedAt).toLocaleString('ru-RU')}</Descriptions.Item>
        <Descriptions.Item label="Отправлено к API">{item.dispatchedAt ? new Date(item.dispatchedAt).toLocaleString('ru-RU') : 'Нет данных'}</Descriptions.Item>
        <Descriptions.Item label="Завершено">{item.finishedAt ? new Date(item.finishedAt).toLocaleString('ru-RU') : 'Нет подтверждения'}</Descriptions.Item>
        <Descriptions.Item label="Время операции">{usageLatency(item.latencyMs)}</Descriptions.Item>
        <Descriptions.Item label="Тип API">{endpointLabels[item.endpoint]}</Descriptions.Item>
        <Descriptions.Item label="Пользователь">{item.actorEmail || 'Серверная задача'}</Descriptions.Item>
        {item.failureCode && <Descriptions.Item label="Причина сбоя">{usageFailure(item.failureCode)} <Typography.Text code>{item.failureCode}</Typography.Text></Descriptions.Item>}
        <Descriptions.Item label="ID записи"><Typography.Text code copyable>{item.id}</Typography.Text></Descriptions.Item>
        {item.operationId && <Descriptions.Item label="ID задания"><Typography.Text code copyable>{item.operationId}</Typography.Text></Descriptions.Item>}
        {item.turnId && <Descriptions.Item label="ID вопроса"><Typography.Text code copyable>{item.turnId}</Typography.Text></Descriptions.Item>}
    </Descriptions></details>;
}

/** Names lead each entry; technical correlation identifiers stay inside its explicit details. */
export function UsageCalls({report, loading, onMore}: {report: UsageReport; loading: boolean; onMore: () => void}): JSX.Element {
    return <Card title="Последние операции" size="small"><List dataSource={report.items} locale={{emptyText: <Empty description="За этот период операций не было"/>}} renderItem={item => <List.Item className="model-usage__call"><div className="model-usage__call-main"><Space wrap><Typography.Text strong>{item.modelName}</Typography.Text><Tag color={item.status === 'success' ? 'green' : item.status === 'error' ? 'red' : item.status === 'pending' ? 'processing' : 'default'}>{statusLabels[item.status]}</Tag></Space>
        <Typography.Text type="secondary">{purposeLabels[item.purpose]} · {protocolLabels[item.provider] ?? item.provider} · {new Date(item.startedAt).toLocaleString('ru-RU')}</Typography.Text>
        <div className="model-usage__call-identity"><Typography.Text>{usageActor(item.actorName, item.actorEmail)}</Typography.Text><span aria-hidden> · </span>{item.projectId && item.projectName ? <Link to={'/projects/' + encodeURIComponent(item.projectId)}>{item.projectName}</Link> : <Typography.Text type="secondary">{usageProject(item.projectName, item.projectId)}</Typography.Text>}{item.agentId && <Typography.Text type="secondary"> · {item.agentName || 'Агент недоступен'}</Typography.Text>}</div>
        <div className="model-usage__call-counts"><span>Обращения к API: {usageCount(item.dispatchCount)}</span><span>Ожидание лимита: {usageLatency(item.rateWaitMs)}</span><span>Время API суммарно: {usageLatency(item.providerLatencyMs)}</span><span>Токены: {usageCount(item.inputTokens)} → {usageCount(item.outputTokens)}</span></div>
        <CallDetails item={item}/>
    </div></List.Item>}/>{report.history.hasMore && <Button loading={loading} onClick={onMore}>Показать ещё</Button>}</Card>;
}
