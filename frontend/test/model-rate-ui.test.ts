import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {ModelRateLimitsContent} from '../src/features/ModelRateLimits/ModelRateLimits';
import {initialModelRateState, rateDraft} from '../src/features/ModelRateLimits/model';
import type {ModelRateLimit, ModelRateState} from '../src/features/ModelRateLimits/types';
const policy: ModelRateLimit = {modelId: 'model-a', revision: 0, requests: 5, windowMs: 5000, enabled: true, canManage: true, featureEnabled: true, updatedAt: null, updatedBy: null};
const state = (patch: Partial<ModelRateState> = {}): ModelRateState => ({...initialModelRateState(), policy, baseRevision: 0, draft: rateDraft(policy), ...patch});
function render(value: ModelRateState): string {return renderToStaticMarkup(createElement(ModelRateLimitsContent, {state: value, controller: {refresh: vi.fn(), save: vi.fn(), edit: vi.fn(), keepDraft: vi.fn(), useCurrent: vi.fn()}}));}
describe('Rate settings presentation', () => {
    it('names the shared bucket and editable seconds with defaults from the actual policy', () => {
        const html = render(state()); expect(html).toContain('5 запросов за 5 с'); expect(html).toContain('Лимит общий для всех пользователей и агентов');
        expect(html).toContain('aria-label="Число запросов"'); expect(html).toContain('aria-label="Период лимита в секундах"'); expect(html).toContain('Сохранить лимит');
    });
    it('global OFF explicitly bypasses enforcement while still allowing admin preparation', () => {
        const html = render(state({policy: {...policy, featureEnabled: false}})); expect(html).toContain('Общий контроль лимитов выключен'); expect(html).toContain('Сохранить лимит');
        expect(html).not.toMatch(/<input[^>]*disabled/); expect(html).not.toMatch(/<button[^>]*disabled[^>]*><span>Сохранить лимит/);
    });
    it('read-only viewers see saved policy without mutation inputs even when feature is off', () => {
        const html = render(state({policy: {...policy, featureEnabled: false, canManage: false}})); expect(html).toContain('5 запросов за 5 с'); expect(html).toContain('главный администратор'); expect(html).not.toContain('Сохранить лимит'); expect(html).not.toContain('aria-label="Число запросов"');
    });
    it('CAS comparison presents both explicit choices without replacing the local draft', () => {
        const html = render(state({draft: {...rateDraft(policy), requests: 8}, conflict: {...policy, revision: 2, requests: 15}}));
        expect(html).toContain('Сейчас на сервере: 15 запросов за 5 с'); expect(html).toContain('value="8"'); expect(html).toContain('Использовать текущие'); expect(html).toContain('Оставить мой ввод'); expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>Сохранить лимит/);
    });
    it('unknown ACK freezes the exact draft and offers a deliberate repeat plus read reconciliation', () => {
        const html = render(state({draft: {...rateDraft(policy), requests: 8}, pending: {expectedRevision: 0, requests: 8, windowMs: 5000, enabled: true}}));
        expect(html).toContain('Повторить сохранение'); expect(html).toContain('Обновить'); expect(html.match(/<input[^>]*disabled=""/g)).toHaveLength(2);
    });
    it('missing or revoked access never displays a fabricated policy or editable input', () => {
        const html = render({...initialModelRateState(), error: 'Нет доступа'}); expect(html).toContain('Нет доступа'); expect(html).not.toContain('5 запросов за 5 с'); expect(html).not.toContain('Сохранить лимит');
    });
});
