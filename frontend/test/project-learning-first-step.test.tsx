// @vitest-environment jsdom
import './feature-flags-enabled';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ProjectLearning} from '../src/features/ProjectLearning/ProjectLearning';
import {learningOverview} from './project-learning-fixtures';
import type {LearningOverview} from '../src/features/ProjectLearning/types';

const f = vi.hoisted(() => ({data: null as LearningOverview | null, uncertain: false, start: vi.fn(), recover: vi.fn(), execute: vi.fn()}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: 'reader', captureOwner: () => () => true})}));
vi.mock('../src/features/ProjectLearning/useProjectLearning', () => ({useProjectLearning: () => ({data: f.data, loading: false, error: '', refresh: vi.fn(), loadMore: vi.fn()})}));
vi.mock('../src/features/ProjectLearning/useLearningResources', () => ({useLearningResources: () => ({models: [], agents: [], loading: false, error: '', refresh: vi.fn()})}));
vi.mock('../src/features/ProjectLearning/useLearningAnalysis', () => ({useLearningAnalysis: () => ({busy: false, pending: false, unconfirmed: f.uncertain, error: '', analysis: null, start: f.start, recover: f.recover})}));
vi.mock('../src/features/ProjectLearning/useLearningActions', () => ({useLearningActions: () => ({busy: false, unconfirmed: false, conflict: false, error: '', execute: f.execute, resetError: vi.fn(), recover: vi.fn()})}));
vi.mock('../src/features/ProjectLearning/useLearningHypothesis', () => ({useLearningHypothesis: () => ({hypothesis: null, loading: false, error: '', nextCursor: null})}));
let root: Root, host: HTMLDivElement;
const settle = async (): Promise<void> => {await act(async () => {for (let n = 0; n < 12; n++) await Promise.resolve();});};
const button = (text: string): HTMLButtonElement | undefined => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
async function render(): Promise<void> {await act(async () => root.render(createElement(ProjectLearning, {projectId: 'prj-learning'}))); await settle();}
beforeEach(() => {
    vi.clearAllMocks(); f.uncertain = false; f.data = learningOverview({experiences: [], hypotheses: [], candidates: [], pages: {experiences: {total: 0, nextCursor: null}, hypotheses: {total: 0, nextCursor: null}, candidates: {total: 0, nextCursor: null}}});
    Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
    const getStyle = window.getComputedStyle; vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getStyle(element));
    window.matchMedia = vi.fn().mockImplementation(() => ({matches: false, addListener: vi.fn(), removeListener: vi.fn()}));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks();});

describe('Empty project learning has one useful next step', () => {
    it('explains why there are no hypotheses and opens a first experience without a model call', async () => {
        await render();
        expect(document.querySelector('[aria-label="Первый шаг обучения проекта"]')?.textContent).toContain('нет сохранённого опыта');
        expect(button('Построить гипотезы')).toBeUndefined(); expect(document.querySelector('input[aria-label="Поиск в загруженном опыте и гипотезах"]')).toBeNull();
        expect(document.querySelector('.project-learning__heading')?.textContent).not.toContain('MCP Memory');
        expect(document.querySelector<HTMLDetailsElement>('.project-learning__exchange')?.open).toBe(false);
        await act(async () => button('Добавить первый опыт')!.click()); await settle();
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Записать опыт проекта');
        expect(f.execute).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    });
    it('keeps history and a permission explanation for a read-only participant', async () => {
        f.data!.capabilities = {read: true, record: false, review: false, approve: false}; await render();
        expect(document.querySelector('[aria-label="Первый шаг обучения проекта"]')).toBeTruthy();
        expect(button('Добавить первый опыт')).toBeUndefined(); expect(button('История')).toBeTruthy();
        expect(document.body.textContent).toContain('Ваша роль разрешает просмотр'); expect(f.start).not.toHaveBeenCalled();
    });
    it('never offers a fresh action before an uncertain analysis receipt has been checked', async () => {
        f.uncertain = true; await render(); expect(button('Добавить первый опыт')?.disabled).toBe(true);
        await act(async () => button('Проверить анализ')!.click()); expect(f.recover).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled();
    });
    it('returns the records, search and analysis controls when experience already exists', async () => {
        f.data = learningOverview(); await render();
        expect(document.querySelector('[aria-label="Первый шаг обучения проекта"]')).toBeNull();
        expect(document.querySelector('input[aria-label="Поиск в загруженном опыте и гипотезах"]')).toBeTruthy();
        expect(button('Добавить опыт')).toBeTruthy(); expect(button('Построить гипотезы')?.disabled).toBe(true);
    });
});
