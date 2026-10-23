import {Button, Collapse, Select} from 'antd';
import {endpointLabels, protocolLabels, purposeLabels, statusLabels} from './presentation';
import type {UsageFacets, UsageFilters, UsagePurpose, UsageStatus} from './types';

interface Props {filters: UsageFilters; facets?: UsageFacets; onChange: <K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) => void; onReset: () => void;}

/** Filter options come from the authorized window, never from a partial or already filtered row page. */
export function UsageFilterFields({filters, facets, onChange, onReset}: Props): JSX.Element {
    return <section aria-label="Фильтры использования"><div className="model-usage__filters">
        <label>Период<Select aria-label="Период использования" value={filters.days} options={[{value: 1, label: 'За день'}, {value: 7, label: 'За 7 дней'}, {value: 30, label: 'За 30 дней'}]} onChange={value => onChange('days', value as UsageFilters['days'])}/></label>
        <label>Проект<Select aria-label="Проект использования" placeholder="Все доступные проекты" allowClear showSearch optionFilterProp="label" value={filters.projectId} options={facets?.projects.map(project => ({value: project.id, label: project.name})) ?? []} onChange={value => onChange('projectId', value)}/></label>
        <label>Пользователь<Select aria-label="Пользователь использования" placeholder="Все доступные пользователи" allowClear showSearch optionFilterProp="label" value={filters.actorEmail} options={facets?.users.map(user => ({value: user.email ?? '__system__', label: user.displayName || user.email || 'Серверные задачи'})) ?? []} onChange={value => onChange('actorEmail', value)}/></label>
        <label>Модель<Select aria-label="Модель" placeholder="Все модели" allowClear showSearch optionFilterProp="label" value={filters.modelId} options={facets?.models.map(model => ({value: model.id, label: model.name})) ?? []} onChange={value => onChange('modelId', value)}/></label>
    </div><Collapse ghost className="model-usage__extra-filters"><Collapse.Panel key="extra" header="Назначение, агенты и результат"><div className="model-usage__filters">
        <label>Агент<Select aria-label="Агент использования" placeholder="Все агенты" allowClear showSearch optionFilterProp="label" value={filters.agentId} options={facets?.agents.map(agent => ({value: agent.id, label: agent.name})) ?? []} onChange={value => onChange('agentId', value)}/></label>
        <label>Назначение<Select aria-label="Назначение вызова" placeholder="Все назначения" allowClear value={filters.purpose} options={Object.entries(purposeLabels).map(([value, label]) => ({value, label}))} onChange={value => onChange('purpose', value as UsagePurpose | undefined)}/></label>
        <label>Результат<Select aria-label="Результат вызова" placeholder="Все результаты" allowClear value={filters.status} options={Object.entries(statusLabels).map(([value, label]) => ({value, label}))} onChange={value => onChange('status', value as UsageStatus | undefined)}/></label>
        <label>Тип API<Select aria-label="Тип API" placeholder="Чат и эмбеддинги" allowClear value={filters.endpoint} options={Object.entries(endpointLabels).map(([value, label]) => ({value, label}))} onChange={value => onChange('endpoint', value as UsageFilters['endpoint'])}/></label>
        <label>Провайдер<Select aria-label="Провайдер API" placeholder="Все провайдеры" allowClear value={filters.provider} options={facets?.providers.map(provider => ({value: provider, label: protocolLabels[provider] ?? provider})) ?? []} onChange={value => onChange('provider', value)}/></label>
    </div></Collapse.Panel></Collapse><Button type="link" onClick={onReset}>Сбросить фильтры</Button></section>;
}
