import {Card, Empty, Typography} from 'antd';
import type {UsageReport} from './types';
import {usageCount} from './presentation';

/** Activity bars show operation count; API counts retain their independent unknown state. */
export function UsageActivity({series, days}: {series: UsageReport['series']; days: number}): JSX.Element {
    const maximum = Math.max(1, ...series.map(row => row.requests));
    return <Card title={days === 1 ? 'Активность по часам' : 'Активность по дням'} size="small">{!series.length ? <Empty description="Активности пока нет"/> : <ol className="model-usage__activity" aria-label={days === 1 ? 'Операции по часам' : 'Операции по дням'}>{series.map(row => {
        const date = new Date(row.periodStart).toLocaleString('ru-RU', days === 1 ? {hour: '2-digit', minute: '2-digit'} : {day: 'numeric', month: 'short'});
        return <li key={row.periodStart} title={`${date}: ${row.requests} операций, ${usageCount(row.apiCalls)} обращений к API`}><Typography.Text strong>{usageCount(row.requests)}</Typography.Text><div className="model-usage__activity-track"><span style={{height: `${row.requests / maximum * 100}%`}} aria-hidden/></div><time dateTime={row.periodStart}>{date}</time><span className="model-usage__sr-only">API: {usageCount(row.apiCalls)}</span></li>;
    })}</ol>}</Card>;
}
