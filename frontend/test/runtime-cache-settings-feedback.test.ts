import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice, IBridgeJob } from '../src/features/McpBridge/api';
import type { useRuntimeCacheSettings } from '../src/features/McpBridge/useRuntimeCacheSettings';
import { RuntimeCacheSettings } from '../src/features/McpBridge/RuntimeCacheSettings';
import { initialRuntimeCacheSettings } from '../src/features/McpBridge/runtimeCacheSettingsController';
import { FeatureAvailabilityContext } from '../src/features/FeatureFlags/FeatureAvailability';
import { featureFlagKeys, type IEvaluatedFeatureFlags } from '../src/features/FeatureFlags/types';

const view = vi.hoisted(() => ({openNext: false, cache: undefined as ReturnType<typeof useRuntimeCacheSettings> | undefined}));
vi.mock('react', async original => {
    const react = await original<typeof import('react')>();
    return {...react, useState: (initial: unknown) => {
        if (view.openNext) {view.openNext = false; return [true, vi.fn()];}
        return react.useState(initial);
    }};
});
vi.mock('../src/features/McpBridge/useRuntimeCacheSettings', () => ({useRuntimeCacheSettings: () => view.cache}));
vi.mock('antd', async original => ({...await original<typeof import('antd')>(),
    // Server rendering has no portal target; retain actual Ant Design form controls and diagnostic Alerts.
    Modal: ({open, children}: {open: boolean; children?: ReactNode}) => open ? createElement('section', null, children) : null,
}));

const device: IBridgeDevice = {id: 'owned-device', name: 'Рабочий компьютер', role: 'Разработчик', fingerprint: 'fixture',
    online: true, lastSeen: null, report: {capabilities: ['runtime-cache-policy-v1']}};
const diagnostic = 'Лимит кэша не изменён: обновите ревизию и повторите действие.';
function render(state: string, message: string, error: string, retention?: {enabled: boolean; reason?: string}, target?: {usedMiB: number; targetMiB: number}) {
    const job: IBridgeJob = {id: 'job', deviceId: device.id, projectId: null, kind: 'runtime-cache-policy', state, message,
        createdAt: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T10:00:00.000Z'};
    view.cache = {...initialRuntimeCacheSettings(), draftMiB: 4096, dirty: true, busy: false, pending: state === 'running', job, error,
        reason: '', setReason: '', canRecover: true, supportsTarget: !!target, activate: vi.fn(), dispose: vi.fn(), edit: vi.fn(),
        ...(target ? {draftMiB: target.targetMiB, status: {schemaVersion: 2 as const, revision: 1, limitBytes: target.targetMiB * 1024 ** 2, usedBytes: target.usedMiB * 1024 ** 2,
            defaultBytes: 2048 * 1024 ** 2, minBytes: 1024 ** 2, maxBytes: Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2) * 1024 ** 2,
            observedAt: '2026-10-24T10:00:00.000Z', cleanup: {enabled: true, keepPrevious: 2, minAgeDays: 7}}} : {}),
        cleanupDraft: {enabled: retention?.enabled ?? true, keepPrevious: 2, minAgeDays: 7}, cleanupReason: retention?.reason ?? '', supportsCleanup: !!retention,
        ...(retention ? {cleanupPolicy: {enabled: retention.enabled, keepPrevious: 2, minAgeDays: 7}} : {}),
        editCleanup: vi.fn(), setCleanup: vi.fn(), inspect: vi.fn(), set: vi.fn(), refresh: vi.fn(), recover: vi.fn()};
    view.openNext = true;
    const data = {flags: Object.fromEntries(featureFlagKeys.map(key => [key, true])), configured: Object.fromEntries(featureFlagKeys.map(key => [key, true])),
        blockedBy: Object.fromEntries(featureFlagKeys.map(key => [key, []]))} as IEvaluatedFeatureFlags;
    return renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider, {value: {data, loading: false, error: null, refresh: vi.fn()}}, createElement(RuntimeCacheSettings, {device})));
}

describe('Runtime cache settings feedback', () => {
    it('presents a soft positive target without a 16 GiB ceiling and explains overage without an error', () => {
        const html = render('succeeded', '', '', undefined, {usedMiB: 25000, targetMiB: 20480});
        expect(html).toContain('Целевой объём кэша, МиБ'); expect(html).toContain('Сохранить целевой объём');
        expect(html).toContain('value="20480"'); expect(html).toContain('Положительное целое число');
        expect(html).not.toContain('16384'); expect(html).not.toContain('от 1024');
        expect(html).toContain('Превышение целевого объёма не останавливает обновления');
        expect(html).toContain('свободное место на диске'); expect(html).toContain('Кэш превышает целевой объём');
        expect(html).not.toContain('ant-alert-error');
        const save = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('Сохранить целевой объём'))!;
        expect(save).not.toContain('disabled');
    });

    it('shows one identical terminal diagnostic, keeps the draft and preserves a distinct running status beside a transport error', () => {
        for (const state of ['failed', 'cancelled']) {
            const html = render(state, diagnostic, diagnostic);
            expect(html.split(diagnostic)).toHaveLength(2);
            expect(html).toContain('role="alert"');
            expect(html).toContain('value="4096"');
            expect(view.cache?.error).toBe(diagnostic);
        }
        const status = 'Компьютер применяет выбранный лимит.', transport = 'Не удалось обновить результат. Проверьте соединение.';
        const html = render('running', status, transport);
        expect(html.split(status)).toHaveLength(2);
        expect(html.split(transport)).toHaveLength(2);
        expect(html).toContain('role="status"');
        expect(html).toContain('role="alert"');
        expect(html).toContain('value="4096"');
    });

    it('keeps disabling cleanup available while OFF and explains its bounded scope beside the existing cache limit', () => {
        const off = 'Очистка выключена главным администратором';
        const enabled = render('succeeded', '', '', {enabled: true, reason: off});
        const save = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('Сохранить хранение копий'))!;
        expect(save(enabled)).toContain('disabled');
        const disabled = render('succeeded', '', '', {enabled: false, reason: off});
        expect(save(disabled)).not.toContain('disabled');
        expect(disabled).toContain('aria-label="Автоочистка копий обновления"');
        expect(disabled).toContain('хотя бы одна копия для отката');
        expect(disabled).toContain('ручные изменения и копии восстановления остаются');
        expect(disabled).toContain('Кэш комплектов эта настройка не очищает');
        expect(disabled).toContain('value="4096"');
        expect(disabled).toContain('id="bridge-cleanup-count-owned-device"');
        expect(disabled).toContain('id="bridge-cleanup-age-owned-device"');
    });

    it('keeps a legacy bridge on its cache-limit form and offers an update without retention controls', () => {
        const html = render('succeeded', '', '');
        expect(html).toContain('Сохранить лимит'); expect(html).toContain('value="4096"');
        expect(html).toContain('Обновите мост, чтобы настроить хранение копий обновления');
        expect(html).not.toContain('Сохранить хранение копий'); expect(html).not.toContain('role="switch"');
    });
});
