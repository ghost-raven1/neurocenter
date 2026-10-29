import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {QuotaEditorContent} from '../src/features/ModelTokenQuotas/ModelTokenQuotas';
import {initialQuotaState} from '../src/features/ModelTokenQuotas/model';
import {identity, input, view} from './model-token-quotas.fixture';
import type {QuotaState} from '../src/features/ModelTokenQuotas/types';

const controls = () => ({refresh: vi.fn(), recover: vi.fn(), reloadJournal: vi.fn(), save: vi.fn(), replay: vi.fn(), edit: vi.fn(), resolveConflict: vi.fn()});
const render = (patch: Partial<QuotaState> = {}) => {const controller = controls(); return {html: renderToStaticMarkup(createElement(QuotaEditorContent, {state: {...initialQuotaState(), view: view(), baseRevision: 0, ...patch}, controller})), controller};};
describe('Compact truthful quota presentation (SSR only)', () => {
    it('names every required field and presents a token period independent from request rate', () => {
        const {html, controller} = render(); expect(html).toContain('Бюджет пользователя в токенах'); expect(html).toContain('Длительность периода квоты'); expect(html).toContain('Единица периода квоты'); expect(html).toContain('365 дней'); expect(html).toContain('Сохранить квоту'); expect(controller.save).not.toHaveBeenCalled();
    });
    it('keeps OFF preconfiguration and uncovered BYOK boundaries visible without claiming a ceiling', () => {
        const {html} = render({view: view({featureEnabled: false, coverage: {managedText: false, reason: 'Прямой локальный BYOK вне managed API не покрыт.'}})});
        expect(html).toContain('Преднастройка'); expect(html).toContain('контроль выключен'); expect(html).toContain('BYOK'); expect(html).toContain('Последний ответ может превысить бюджет');
    });
    it('renders unknown actual, active reserve, held estimate and overrun as distinct facts', () => {
        const value = view(); Object.assign(value.counters, {actualInputTokens: null, actualOutputTokens: '900719925474099300000', activeReservedTokens: '22', unknownHeldTokens: '33', unknownCalls: 1, overrunTokens: '44'});
        const {html} = render({view: value}); for (const label of ['Неизвестно', 'Факт: вход', 'Факт: выход', 'Резерв · оценка', 'Неизвестный расход', 'Перерасход']) expect(html).toContain(label);
        expect(html).toContain('900\u00a0719\u00a0925\u00a0474\u00a0099\u00a0300\u00a0000');
    });
    it('keeps receipt recovery outside locked inputs and exposes no private counters after403', () => {
        const {html} = render({view: undefined, pending: {schemaVersion: 1, ...identity, input: input()}, error: 'Доступ запрещён'});
        expect(html).toContain('Проверить подтверждение'); expect(html).toContain('Доступ запрещён'); expect(html).not.toContain('Факт: вход'); expect(html).not.toContain('Бюджет пользователя в токенах'); expect(html).not.toContain('Повторить тот же запрос');
    });
    it('puts detailed actual/metadata under a native disclosure and omits a zero overrun', () => {
        const {html} = render(); expect(html).toContain('<summary>Подробности расхода</summary>'); expect(html).not.toContain('Перерасход'); expect(html).not.toMatch(/<details[^>]*\sopen/);
    });
});
