// @vitest-environment jsdom
import {act, createElement, useEffect, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {Simulate} from 'react-dom/test-utils';
import {createMemoryHistory} from 'history';
import {Router} from 'react-router-dom';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {MaintenanceSections} from '../src/modules/Maintenance/MaintenanceSections';
import {FeatureFlagsPanel} from '../src/features/FeatureFlags/FeatureFlagsPanel';
import {featureDefinition} from '../src/features/FeatureFlags/types';
import {initialFeatureFlagsState} from '../src/features/FeatureFlags/featureFlagsController';

const f = vi.hoisted(() => ({mounts: 0, scheduleVisible: true, scroll: vi.fn(), save: vi.fn(), rows: {} as Record<string, any>}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: {id: 'admin', email: 'admin@test', activeRole: 'Главный админ', userRoles: ['Главный админ'], routePermissions: [], projectRoles: []}, policies: {}}})}));
vi.mock('../src/features/FeatureFlags/useFeatureFlags', () => ({useFeatureFlags: () => ({...initialFeatureFlagsState(), items: ['model_hosting', 'rag_sync'].map(key => ({...featureDefinition(key as 'model_hosting' | 'rag_sync'), enabled: true, revision: 1, updatedAt: '', updatedBy: ''})), rows: f.rows, refresh: vi.fn(), save: f.save, retryChoice: vi.fn(), useCurrent: vi.fn()})}));
let root: Root, host: HTMLDivElement, history: ReturnType<typeof createMemoryHistory>, complete: () => void;
function Backups() {
    const [result, setResult] = useState('Готово к работе'); useEffect(() => {f.mounts++;}, []);
    return createElement('div', null, createElement('input', {'aria-label': 'Черновик расписания', defaultValue: ''}), createElement('button', {onClick: () => {setResult('Операция выполняется'); complete = () => setResult('Результат сохранён');}}, 'Проверить состояние'), createElement('p', {role: 'status'}, result), f.scheduleVisible && createElement('h3', {id: 'maintenance-schedule-title'}, 'Расписание'));
}
async function render() {await act(async () => root.render(createElement(Router, {history}, createElement(MaintenanceSections, {backups: createElement(Backups), storage: 'Сведения о хранилищах', features: createElement(FeatureFlagsPanel)}))));}
async function tab(name: string) {await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent === name)!.click());}
const selected = () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
beforeEach(() => {vi.clearAllMocks(); f.mounts = 0; f.scheduleVisible = true; Element.prototype.scrollIntoView = f.scroll; f.rows = Object.fromEntries(['model_hosting', 'rag_sync'].map(key => [key, {saving: false, error: null, needsReview: false, saved: false}]));
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true}); vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {callback(); return 1;}); vi.stubGlobal('cancelAnimationFrame', vi.fn()); window.matchMedia = vi.fn().mockImplementation(() => ({matches: false, addListener: vi.fn(), removeListener: vi.fn()}));
    history = createMemoryHistory({initialEntries: ['/maintenance?existing=keep']}); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});
it('opens backups by default and keeps the form, pending operation and result mounted while switching', async () => {
    await render(); expect(selected()).toBe('Резервные копии'); const input = document.querySelector<HTMLInputElement>('[aria-label="Черновик расписания"]')!; input.value = 'Новое время';
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === 'Проверить состояние')!.click());
    await tab('Хранилища'); expect(f.mounts).toBe(1); expect(document.querySelector('#maintenance-backups')?.isConnected).toBe(true);
    await act(async () => complete()); await tab('Резервные копии'); expect(input.value).toBe('Новое время'); expect(document.querySelector('#maintenance-backups')?.textContent).toContain('Результат сохранён'); expect(f.mounts).toBe(1);
});
it('preserves URL parameters and selects the backup panel for an existing schedule hash', async () => {
    f.scheduleVisible = false; await act(async () => history.replace('/maintenance?existing=keep&tab=features#maintenance-schedule-title')); await render(); expect(selected()).toBe('Резервные копии'); expect(f.scroll).not.toHaveBeenCalled();
    f.scheduleVisible = true; await render(); expect(f.scroll).toHaveBeenCalledExactlyOnceWith({block: 'start'});
    await tab('Хранилища'); expect(history.location.search).toContain('existing=keep'); expect(history.location.search).toContain('tab=storage'); expect(history.location.hash).toBe('');
    await act(async () => history.push('/maintenance?tab=features')); expect(selected()).toBe('Функции платформы');
});
it('keeps an explicit storage deep link instead of selecting the default panel', async () => {
    history = createMemoryHistory({initialEntries: ['/maintenance?tab=storage']}); await render(); expect(selected()).toBe('Хранилища');
});
it('filters functions without changing them and retains an unmatched row with an unresolved error', async () => {
    f.rows.model_hosting.error = 'Подтверждение не получено'; await render(); await tab('Функции платформы');
    const input = document.querySelector<HTMLInputElement>('[aria-label="Поиск функций платформы"]')!;
    await act(async () => Simulate.change(input, {target: {value: 'нет такой функции'}} as any));
    const rows = [...document.querySelectorAll<HTMLElement>('.feature-flags__row')]; expect(rows.find(row => row.textContent?.includes('Хостинг моделей'))?.parentElement?.hidden).toBe(false);
    expect(rows.find(row => row.textContent?.includes('Обновление базы знаний'))?.parentElement?.hidden).toBe(true); expect(document.body.textContent).toContain('Подтверждение не получено'); expect(f.save).not.toHaveBeenCalled();
});
