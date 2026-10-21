import { Alert, Button, Card, Empty, List, Select, Space, Spin, Statistic, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { PageHeading } from '../../common/components/PageHeading';
import { useModelUsage } from './useModelUsage';
import { protocolLabels, purposeLabels, statusLabels, usageCount, usageLatency } from './presentation';
import type { UsageFilters, UsagePurpose, UsageStatus } from './types';
import './ModelUsage.less';
import {FeatureAvailabilityNotice,useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';

/** One view for actual model calls, with explicit unknown usage rather than invented prices. */
function AvailableModelUsagePage(): JSX.Element {
    const [filters, setFilters] = useState<UsageFilters>({ days: 7 }), { data, loading, error, refresh, more } = useModelUsage(filters);
    const role = useSelector((state: RootState) => state.userBlock.user?.activeRole);
    const filter = <K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => setFilters(previous => ({ ...previous, [key]: value }));
    return <section className="model-usage"><PageHeading title="Использование моделей" description={role === 'Главный админ' ? 'Вызовы моделей на сервере: чаты, агенты, поиск и обработка данных.' : role === 'Админ проекта' ? 'Вызовы моделей в проектах, которыми вы управляете.' : 'Ваши вызовы моделей в доступных проектах.'} actions={<Button loading={loading} onClick={() => void refresh()}>Обновить</Button>} />
        <div className="model-usage__filters">
            <Select aria-label="Период использования" value={filters.days} options={[{ value: 1, label: 'За день' }, { value: 7, label: 'За 7 дней' }, { value: 30, label: 'За 30 дней' }]} onChange={value => filter('days', value as UsageFilters['days'])} />
            <Select aria-label="Модель" placeholder="Все модели" allowClear value={filters.modelId} options={data?.byModel.map(model => ({ value: model.modelId, label: model.name })) ?? []} onChange={value => filter('modelId', value)} />
            <Select aria-label="Назначение вызова" placeholder="Все назначения" allowClear value={filters.purpose} options={Object.entries(purposeLabels).map(([value, label]) => ({ value, label }))} onChange={value => filter('purpose', value as UsagePurpose | undefined)} />
            <Select aria-label="Результат вызова" placeholder="Все результаты" allowClear value={filters.status} options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))} onChange={value => filter('status', value as UsageStatus | undefined)} />
        </div>
        {error && <Alert showIcon type="error" message={error} />}
        {loading && !data ? <Spin aria-label="Загрузка использования моделей" /> : data && <>
            <div className="model-usage__metrics">
                <Card size="small"><Statistic title="Вызовы" value={data.summary.requests} /><Typography.Text type="secondary">Успешно {data.summary.success} · Ошибки {data.summary.error}</Typography.Text></Card>
                <Card size="small"><Statistic title="Выполняются" value={data.summary.pending} /><Typography.Text type="secondary">Остановлено {data.summary.cancelled} · Без подтверждения {data.summary.interrupted}</Typography.Text></Card>
                <Card size="small"><Statistic title="Входные токены" value={usageCount(data.summary.inputTokens)} /><Typography.Text type="secondary">Нет счётчика у {data.summary.unknownInputRequests} вызовов</Typography.Text></Card>
                <Card size="small"><Statistic title="Выходные токены" value={usageCount(data.summary.outputTokens)} /><Typography.Text type="secondary">Нет счётчика у {data.summary.unknownOutputRequests} вызовов</Typography.Text></Card>
            </div>
            <Typography.Paragraph type="secondary">Токены учитываются по счётчикам модели. «Нет данных» сохраняется, если модель их не передала.</Typography.Paragraph>
            <div className="model-usage__breakdowns">
                <Card size="small" title="Самые используемые модели"><List size="small" dataSource={data.byModel} locale={{ emptyText: 'Вызовов пока нет' }} renderItem={model => <List.Item><Typography.Text>{model.name}</Typography.Text><Typography.Text type="secondary">{model.requests} выз. · {usageLatency(model.averageLatencyMs)}</Typography.Text></List.Item>} /></Card>
                <Card size="small" title="По назначению"><List size="small" dataSource={data.byPurpose} locale={{ emptyText: 'Вызовов пока нет' }} renderItem={purpose => <List.Item><Typography.Text>{purposeLabels[purpose.purpose]}</Typography.Text><Typography.Text type="secondary">{purpose.requests} выз.</Typography.Text></List.Item>} /></Card>
            </div>
            <Card title="Последние вызовы" size="small"><List dataSource={data.items} locale={{ emptyText: <Empty description="За этот период вызовов не было" /> }} renderItem={item => <List.Item className="model-usage__call"><div className="model-usage__call-main"><Space wrap><Typography.Text strong>{item.modelName}</Typography.Text><Tag color={item.status === 'success' ? 'green' : item.status === 'error' ? 'red' : item.status === 'pending' ? 'processing' : 'default'}>{statusLabels[item.status]}</Tag></Space>
                <Typography.Text type="secondary">{purposeLabels[item.purpose]} · {protocolLabels[item.provider] ?? item.provider} · {new Date(item.startedAt).toLocaleString('ru-RU')}</Typography.Text>
                <Typography.Text type="secondary">{item.actorEmail ?? 'Серверная задача'}{item.projectId ? ' · ' + item.projectId : ''}</Typography.Text></div>
                <div className="model-usage__call-counts"><Typography.Text>{usageLatency(item.latencyMs)}</Typography.Text><Typography.Text type="secondary">Вход: {usageCount(item.inputTokens)} · Выход: {usageCount(item.outputTokens)}</Typography.Text></div></List.Item>} />
                {data.history.hasMore && <Button loading={loading} onClick={() => void more()}>Показать ещё</Button>}
            </Card>
        </>}
    </section>;
}

/** Turning the report off does not stop the mandatory server usage ledger. */
export default function ModelUsagePage():JSX.Element {
    const availability=useFeatureAvailability('model_usage');
    return availability.enabled?<AvailableModelUsagePage/>:<section><PageHeading title="Использование моделей" description="Журнал фактических вызовов продолжает работать независимо от доступности отчёта."/><FeatureAvailabilityNotice features={['model_usage']}/></section>;
}
