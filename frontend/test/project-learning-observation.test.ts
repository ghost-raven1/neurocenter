import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {LearningEvidenceSummary} from '../src/features/ProjectLearning/LearningEvidenceSummary';
import {observationMetadata} from '../src/features/ProjectLearning/observationMetadata';
import type {LearningExperience} from '../src/features/ProjectLearning/types';

const metadata = {observerVersion: 1, observedAt: '2026-10-21T05:00:00.000Z', sessionEvent: 'idle', toolObservations: {read: 2, bash: 1}, calls: 3, truncated: false, elapsedMs: 1234};
const evidence: LearningExperience['evidence'][number] = {kind: 'observation', status: 'unknown', summary: JSON.stringify(metadata), reference: 'opencode-session-sha256:' + 'a'.repeat(64)};
describe('Automatic observation disclosure', () => {
    it('Recognizes the exact device collector and shows understandable counters', () => {
        expect(observationMetadata('device', evidence)).toEqual(metadata);
        const html = renderToStaticMarkup(createElement(LearningEvidenceSummary, {origin: 'device', evidence}));
        for (const label of ['OpenCode ожидает следующий запрос', 'Наблюдений инструментов', 'read', 'Исходные метаданные', 'не подтверждают успех']) expect(html).toContain(label);
        expect(html).not.toContain('observerVersion');
    });
    it('Discloses truncated counts and session errors without claiming task failure', () => {
        const html = renderToStaticMarkup(createElement(LearningEvidenceSummary, {origin: 'device', evidence: {...evidence, summary: JSON.stringify({...metadata, truncated: true, sessionEvent: 'error'})}}));
        expect(html).toContain('Ошибка сессии'); expect(html).toContain('Счётчики неполные');
    });
    it.each(['human', 'device'] as const)('Never interprets unknown versions or malformed metadata for %s', origin => {
        for (const summary of ['{bad', JSON.stringify({...metadata, observerVersion: 2}), JSON.stringify({...metadata, calls: 9}), JSON.stringify({...metadata, toolObservations: {secret: 3}})]) expect(observationMetadata(origin, {...evidence, summary})).toBeNull();
    });
    it('Manual evidence and an ordinary reference remain verbatim text even with valid-looking JSON', () => {
        expect(observationMetadata('human', evidence)).toBeNull(); expect(observationMetadata('device', {...evidence, reference: 'manual-note'})).toBeNull();
        const html = renderToStaticMarkup(createElement(LearningEvidenceSummary, {origin: 'human', evidence})); expect(html).toContain('observerVersion'); expect(html).not.toContain('Исходные метаданные');
    });
});
