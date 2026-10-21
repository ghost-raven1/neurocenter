import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ProjectLearning} from '../src/features/ProjectLearning/ProjectLearning';
import {candidate, learningOverview, learningProject} from './project-learning-fixtures';
import type {LearningOverview} from '../src/features/ProjectLearning/types';

const ui = vi.hoisted(() => ({query: '', data: null as LearningOverview | null}));
vi.mock('react', async original => {
    const react = await original<typeof import('react')>();
    return {...react, useState: (initial: unknown) => react.useState(initial === 'hypotheses' ? 'knowledge' : initial === '' ? ui.query : initial)};
});
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: 'reader', captureOwner: () => () => true})}));
vi.mock('../src/features/ProjectLearning/useProjectLearning', () => ({useProjectLearning: () => ({data: ui.data, loading: false, error: '', refresh: vi.fn(), loadMore: vi.fn(), loadingMore: null})}));
vi.mock('../src/features/ProjectLearning/useLearningResources', () => ({useLearningResources: () => ({models: [], agents: [], loading: false, error: '', refresh: vi.fn()})}));
vi.mock('../src/features/ProjectLearning/useLearningActions', () => ({useLearningActions: () => ({busy: false, error: '', conflict: false, unconfirmed: false, execute: vi.fn(), recover: vi.fn(), resetError: vi.fn()})}));
vi.mock('../src/features/ProjectLearning/useLearningAnalysis', () => ({useLearningAnalysis: () => ({analysis: null, busy: false, error: '', unconfirmed: false, notFound: false, pending: false})}));
vi.mock('../src/features/ProjectLearning/useLearningHypothesis', () => ({useLearningHypothesis: () => ({hypothesis: null})}));

beforeEach(() => {
    ui.query = 'Правило вне страницы';
    const active = candidate({id: '77777777-7777-4777-8777-777777777777', title: ui.query, status: 'approved', active: true});
    ui.data = learningOverview({candidates: [candidate({version: 2})], activeCandidates: [active],
        pages: {experiences: {nextCursor: null, total: 1}, hypotheses: {nextCursor: null, total: 1}, candidates: {nextCursor: 'next-page', total: 2}},
        capabilities: {read: true, record: false, review: false, approve: false}});
});

describe('Learning search includes accepted knowledge outside the loaded candidate page', () => {
    it('Shows the matching active version without a contradictory empty result', () => {
        const html = renderToStaticMarkup(createElement(ProjectLearning, {projectId: learningProject}));
        expect(html).toContain('Правило вне страницы');
        expect(html).not.toContain('Поиск не дал результатов');
    });
    it('Shows the empty result when no loaded or active entry matches', () => {
        ui.query = 'Нет такого знания';
        const html = renderToStaticMarkup(createElement(ProjectLearning, {projectId: learningProject}));
        expect(html).toContain('Поиск не дал результатов');
    });
});
