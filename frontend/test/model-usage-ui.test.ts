import './feature-flags-enabled';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {UsageMetrics} from '../src/features/ModelUsage/UsageMetrics';
import {UsageCalls} from '../src/features/ModelUsage/UsageCalls';
import {UsageFilterFields} from '../src/features/ModelUsage/UsageFilterFields';
import {UsageActivity} from '../src/features/ModelUsage/UsageActivity';
import {AvailableModelUsagePage} from '../src/features/ModelUsage/ModelUsagePage';
import {usageReport, usageTotals} from './model-usage.fixture';
import type {UsageReport} from '../src/features/ModelUsage/types';
const fixture = vi.hoisted(() => ({data: undefined as UsageReport | undefined, role: 'Главный админ'}));
vi.mock('../src/features/ModelUsage/useModelUsage', () => ({useModelUsage: () => ({data: fixture.data, facets: fixture.data?.facets, loading: false, error: '', refresh: vi.fn(), more: vi.fn()})}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: {activeRole: fixture.role}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: fixture.role, captureOwner: () => () => true})}));
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, {}, element));
beforeEach(() => {fixture.data = usageReport(); fixture.role = 'Главный админ';});
describe('Detailed usage report', () => {
    it('separates accepted operations, actual API attempts, unknown counters and measured zeros', () => {
        const html = render(createElement(UsageMetrics, {value: {...usageTotals, requests: 3, apiCalls: '5', unknownDispatchRequests: 1, rateWaitMs: '0', averageProviderLatencyMs: 0}}));
        expect(html).toContain('Операции'); expect(html).toContain('Попытки отправки'); expect(html).toContain('>5<'); expect(html).toContain('Без счётчика отправок: 1 операций'); expect(html).toContain('0 мс'); expect(html).toContain('Нет данных'); expect(html).toContain('может содержать несколько попыток отправки');
        expect(render(createElement(UsageMetrics, {value: usageTotals}))).not.toContain('Нет данных мс');
    });
    it('displays human names and the project link before technical details, preserving unknown API metrics', () => {
        const report = usageReport(['technical-call-id']); report.items[0].failureCode = 'PROVIDER_TIMEOUT'; report.items[0].operationId = 'technical-job-id';
        const html = render(createElement(UsageCalls, {report, loading: false, onMore: vi.fn()}));
        expect(html).toContain('Алиса'); expect(html).toContain('Нейроцентр'); expect(html).toContain('href="/projects/project-a"'); expect(html).toContain('Тестировщик'); expect(html).toContain('Попытки отправки: Нет данных'); expect(html).toContain('PROVIDER_TIMEOUT');
        const beforeDetails = html.slice(0, html.indexOf('<details')); expect(beforeDetails).not.toContain('technical-call-id'); expect(beforeDetails).not.toContain('technical-job-id'); expect(html).toContain('<summary>Подробности операции</summary>');
    });
    it('filter choices use full authorized facets, with system tasks distinct from an empty selection', () => {
        const html = render(createElement(UsageFilterFields, {filters: {days: 7, modelId: 'model-b', actorEmail: '__system__'}, facets: usageReport().facets, onChange: vi.fn(), onReset: vi.fn()}));
        expect(html).toContain('Model B'); expect(html).toContain('Серверные задачи'); expect(html).toContain('Проект использования'); expect(html).toContain('Сбросить фильтры'); expect(html).toContain('Назначение, агенты и результат');
    });
    it('a removed project remains in the record without an unusable navigation link', () => {
        const report = usageReport(); report.items[0].projectName = null;
        const html = render(createElement(UsageCalls, {report, loading: false, onMore: vi.fn()}));
        expect(html).toContain('Проект недоступен'); expect(html).not.toContain('href="/projects/project-a"');
    });
    it.each(['all', 'projects', 'self'] as const)('server %s scope determines the report explanation independently of the old Redux role label', kind => {
        fixture.data = {...usageReport(), scope: {kind, actorEmail: null, projectIds: []}};
        const html = render(createElement(AvailableModelUsagePage));
        expect(html).toContain(kind === 'all' ? 'Все пользователи и серверные задачи.' : kind === 'projects' ? 'Все пользователи в проектах, которыми вы управляете.' : 'Только ваши операции в доступных проектах.'); expect(html).toContain('Итоги рассчитаны за весь выбранный период');
    });
    it('activity uses hourly buckets for a one-day window and preserves unknown API counters in accessible content', () => {
        const html = render(createElement(UsageActivity, {days: 1, series: [{...usageTotals, periodStart: '2026-10-23T10:00:00Z'}, {...usageTotals, requests: 0, periodStart: '2026-10-23T11:00:00Z'}]}));
        expect(html).toContain('Активность по часам'); expect(html).toContain('Операции по часам'); expect(html).toContain('API: Нет данных'); expect(html).toContain('height:0%');
    });
    it('older report DTO without added metrics is readable with unknown rather than invented API totals', () => {
        const report = usageReport(); const {apiCalls: _apiCalls, rateWaitMs: _rateWaitMs, averageProviderLatencyMs: _latency, ...oldSummary} = report.summary;
        fixture.data = {...report, scope: undefined, series: undefined, byActor: undefined, byProject: undefined, summary: oldSummary} as unknown as UsageReport;
        const html = render(createElement(AvailableModelUsagePage)); expect(html).toContain('Нет данных'); expect(html).toContain('Все пользователи и серверные задачи.'); expect(html).toContain('Активности пока нет');
    });
});
