import {Alert, Button, Spin, Typography} from 'antd';
import {useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {PageHeading} from '../../common/components/PageHeading';
import {FeatureAvailabilityNotice, useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useModelUsage} from './useModelUsage';
import {UsageFilterFields} from './UsageFilterFields';
import {UsageMetrics} from './UsageMetrics';
import {UsageBreakdowns} from './UsageBreakdowns';
import {UsageActivity} from './UsageActivity';
import {UsageCalls} from './UsageCalls';
import type {UsageFilters} from './types';
import './ModelUsage.less';

/** Reports cover the full authorized period; the recent list is paged independently. */
function ScopedModelUsagePage(): JSX.Element {
    const [filters, setFilters] = useState<UsageFilters>({days: 7}), report = useModelUsage(filters);
    const role = useSelector((state: RootState) => state.userBlock.user?.activeRole);
    const kind = report.data?.scope?.kind ?? (role === 'Главный админ' ? 'all' : role === 'Админ проекта' ? 'projects' : 'self');
    const description = kind === 'all' ? 'Все пользователи и серверные задачи.' : kind === 'projects' ? 'Все пользователи в проектах, которыми вы управляете.' : 'Только ваши операции в доступных проектах.';
    const filter = <K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => setFilters(previous => previous[key] === value ? previous : {...previous, [key]: value});
    return <section className="model-usage"><PageHeading title="Использование моделей" description={description} actions={<Button loading={report.loading} onClick={() => void report.refresh()}>Обновить</Button>}/>
        <UsageFilterFields filters={filters} facets={report.facets} onChange={filter} onReset={() => setFilters({days: 7})}/>
        {report.error && <Alert showIcon type="error" message={report.error} action={<Button size="small" onClick={() => void report.refresh()}>Повторить</Button>}/>}
        {report.loading && !report.data ? <Spin aria-label="Загрузка использования моделей"/> : report.data && <>
            <UsageMetrics value={report.data.summary}/><UsageBreakdowns report={report.data}/><UsageActivity series={report.data.series ?? []} days={report.data.window.days}/>
            <UsageCalls report={report.data} loading={report.loading} onMore={() => void report.more()}/>
            <Typography.Text type="secondary">Итоги рассчитаны за весь выбранный период. В списке показано {report.data.items.length} операций.</Typography.Text>
        </>}
    </section>;
}

/** Filter selections belong to the same owner as the report, including a selected user's email. */
export function AvailableModelUsagePage(): JSX.Element {
    const {scope} = useAuthRequestOwner();
    return <ScopedModelUsagePage key={scope}/>;
}

/** Turning the report off does not stop the mandatory server usage ledger. */
export default function ModelUsagePage(): JSX.Element {
    const availability = useFeatureAvailability('model_usage');
    return availability.enabled ? <AvailableModelUsagePage/> : <section><PageHeading title="Использование моделей" description="Журнал фактических вызовов продолжает работать независимо от доступности отчёта."/><FeatureAvailabilityNotice features={['model_usage']}/></section>;
}
