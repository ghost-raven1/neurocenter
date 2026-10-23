import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IBridgeDevice, IBridgeJob } from '../src/features/McpBridge/api';
import type { useRuntimeCacheSettings } from '../src/features/McpBridge/useRuntimeCacheSettings';
import { RuntimeCacheSettings } from '../src/features/McpBridge/RuntimeCacheSettings';

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
function render(state: string, message: string, error: string) {
    const job: IBridgeJob = {id: 'job', deviceId: device.id, projectId: null, kind: 'runtime-cache-policy', state, message,
        createdAt: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T10:00:00.000Z'};
    view.cache = {draftMiB: 4096, dirty: true, busy: false, pending: state === 'running', job, error,
        reason: '', setReason: '', canRecover: true, activate: vi.fn(), dispose: vi.fn(), edit: vi.fn(),
        inspect: vi.fn(), set: vi.fn(), refresh: vi.fn(), recover: vi.fn()};
    view.openNext = true;
    return renderToStaticMarkup(createElement(RuntimeCacheSettings, {device}));
}

describe('Runtime cache settings feedback', () => {
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
});
