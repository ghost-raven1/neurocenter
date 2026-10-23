import {Card, Statistic, Typography} from 'antd';
import {usageCount, usageLatency} from './presentation';
import type {UsageTotals} from './types';

/** Operations, send attempts and provider-reported usage stay distinct from confirmed billing. */
export function UsageMetrics({value}: {value: UsageTotals}): JSX.Element {
    return <><div className="model-usage__metrics">
        <Card size="small"><Statistic title="Операции" value={value.requests}/><Typography.Text type="secondary">Успешно {value.success} · Ошибки {value.error} · В работе {value.pending}</Typography.Text></Card>
        <Card size="small"><Statistic title="Попытки отправки" value={usageCount(value.apiCalls)}/><Typography.Text type="secondary">Без счётчика отправок: {value.unknownDispatchRequests ?? value.requests} операций</Typography.Text></Card>
        <Card size="small"><Statistic title="Время API на операцию" value={usageLatency(value.averageProviderLatencyMs)}/><Typography.Text type="secondary">Ожидание лимита суммарно: {usageCount(value.rateWaitMs)}{value.rateWaitMs != null ? ' мс' : ''}</Typography.Text></Card>
        <Card size="small"><Statistic title="Входные токены" value={usageCount(value.inputTokens)}/><Typography.Text type="secondary">Нет счётчика у {value.unknownInputRequests} операций</Typography.Text></Card>
        <Card size="small"><Statistic title="Выходные токены" value={usageCount(value.outputTokens)}/><Typography.Text type="secondary">Нет счётчика у {value.unknownOutputRequests} операций</Typography.Text></Card>
        <Card size="small"><Statistic title="Среднее время операции" value={usageLatency(value.averageLatencyMs)}/><Typography.Text type="secondary">Остановлено {value.cancelled} · Без подтверждения {value.interrupted}</Typography.Text></Card>
    </div><Typography.Paragraph type="secondary">Операция — одно задание модели; она может содержать несколько попыток отправки. Для Codex на компьютере счётчик фиксирует разрешение отправки, которое ещё не подтверждает ответ или оплату. Токены учитываются по данным провайдера; отсутствующие счётчики показываются как «Нет данных».</Typography.Paragraph></>;
}
