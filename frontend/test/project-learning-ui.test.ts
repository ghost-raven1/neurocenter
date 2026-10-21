import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {LearningCandidateList} from '../src/features/ProjectLearning/LearningCandidateList';
import {LearningHypothesisList} from '../src/features/ProjectLearning/LearningHypothesisList';
import {LearningHypothesisDetails} from '../src/features/ProjectLearning/LearningHypothesisDetails';
import {candidate, check, experience, hypothesis} from './project-learning-fixtures';
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({captureOwner: () => () => true})}));
vi.mock('antd', async original => ({...await original<typeof import('antd')>(), Drawer: ({children, footer}: {children?: import('react').ReactNode; footer?: import('react').ReactNode}) => createElement('section', null, children, footer)}));
const noop = () => undefined;

describe('Learning review remains clear and permission-bound', () => {
    it('A proposed lesson is explicitly pending approval and never presented as active', () => {
        const html = renderToStaticMarkup(createElement(LearningCandidateList, {items: [candidate()], canApprove: true, blocked: false, onAction: noop, onHypothesis: noop}));
        expect(html).toContain('На одобрении'); expect(html).toContain('Проверить и одобрить'); expect(html).not.toContain('Вернуть эту версию'); expect(html).not.toContain('>Отозвать<');
    });
    it('A reader sees context and versions without approve/revoke/rollback controls', () => {
        const html = renderToStaticMarkup(createElement(LearningCandidateList, {items: [candidate({status: 'approved', active: true})], canApprove: false, blocked: false, onAction: noop, onHypothesis: noop}));
        expect(html).toContain('Действует'); expect(html).not.toContain('Проверить и одобрить'); expect(html).not.toContain('>Отозвать<');
    });
    it('Rollback is offered only for an approved inactive version; revocation never silently restores an older one', () => {
        const render = (status: 'approved' | 'revoked', active: boolean) => renderToStaticMarkup(createElement(LearningCandidateList, {items: [candidate({status, active})], canApprove: true, blocked: false, onAction: noop, onHypothesis: noop}));
        expect(render('approved', false)).toContain('Вернуть эту версию'); expect(render('revoked', false)).not.toContain('Вернуть эту версию'); expect(render('approved', true)).toContain('Отозвать');
    });
    it('LLM assessments cannot unlock preparation of accepted knowledge', () => {
        const html = renderToStaticMarkup(createElement(LearningHypothesisDetails, {hypothesis: hypothesis({status: 'supported', checks: [check({method: 'llm_assessment'})]}), experiences: [experience()], canRecord: true, canReview: true, blocked: false,
            loading: false, error: '', nextCursor: null, onMore: noop, onRetry: noop, onClose: noop, onCheck: noop, onCandidate: noop}));
        expect(html).toContain('Оценка модели · не подтверждение'); expect(html).toMatch(/disabled=""[^>]*>[^<]*<span>Подготовить знание/);
    });
    it('Untrusted titles/statements are plain React text, not executable page markup', () => {
        const html = renderToStaticMarkup(createElement(LearningHypothesisList, {items: [hypothesis({title: '<img src=x onerror=alert(1)>', statement: '<script>throw 1</script>'})], onOpen: noop}));
        expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>throw'); expect(html).not.toContain('<img src=x');
    });
});
