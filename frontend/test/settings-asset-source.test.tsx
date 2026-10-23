import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AssetSourceSettings} from '../src/modules/Settings/AssetSourceSettings';
import type {ISourceList} from '../src/features/AssetSources/types';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{value?: unknown; deps?: unknown[]; cleanup?: () => void}> = [], effects: Array<() => void> = [];
    const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    return {begin: () => { cursor = 0; }, commit: () => effects.splice(0).forEach(run => run()), dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial: T) { const slot = slots[cursor++] ??= {value: initial}; return [slot.value, (next: T) => { slot.value = next; }]; },
        useRef<T>(initial?: T) { return (slots[cursor++] ??= {value: {current: initial}}).value; },
        useCallback<T>(callback: T, deps: unknown[]) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = {value: callback, deps}; return slots[index].value; },
        useEffect(effect: () => void | (() => void), deps: unknown[]) { const index = cursor++, old = slots[index]; if (old && same(old.deps, deps)) return; const slot = slots[index] = {deps}; effects.push(() => { old?.cleanup?.(); slot.cleanup = effect() || undefined; }); },
    };
});
const io = vi.hoisted(() => ({active: true, get: vi.fn(), refresh: undefined as undefined | {loading: boolean; onClick: () => void}}));
const captureOwner = () => () => io.active;
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: hooks.useState, useRef: hooks.useRef, useCallback: hooks.useCallback, useEffect: hooks.useEffect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({captureOwner})}));
vi.mock('../src/core/api', () => ({baseApi: {get: io.get}}));
vi.mock('react-router-dom', () => ({Link: ({children, to}: {children?: ReactNode; to: string}) => createElement('a', {href: to}, children)}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Card: ({children, extra}: {children?: ReactNode; extra?: ReactNode}) => createElement('div', null, extra, children), Typography: {Paragraph: content, Text: content}, Space: content, Tag: content,
        Alert: ({message, description}: {message?: ReactNode; description?: ReactNode}) => createElement('div', null, message, description),
        Button: (props: {loading: boolean; onClick: () => void; children?: ReactNode}) => { io.refresh = props; return props.children; }};
});
const source: ISourceList['source'] = {repository: 'company/approved-assets', mode: 'online', commit: 'a'.repeat(40), verified: true};
const response = (value = source) => ({data: {source: value, assets: []} satisfies ISourceList});
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
function render() { hooks.begin(); const html = renderToStaticMarkup(createElement(AssetSourceSettings)); hooks.commit(); return html; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
beforeEach(() => { vi.resetAllMocks(); io.active = true; io.refresh = undefined; io.get.mockResolvedValue(response()); });
afterEach(() => hooks.dispose());

describe('Источник ассетов в настройках читает фактический снимок и сохраняет путь продолжения', () => {
    it('Показывает repository/commit API без придуманного редактора и снимает loading после чтения', async () => {
        render(); await flush(); const html = render(); expect(html).toContain(source.repository); expect(html).toContain(source.commit); expect(html).toContain('href="/assets"');
        expect(io.get).toHaveBeenCalledExactlyOnceWith('/api/asset-sources', {signal: expect.any(AbortSignal), timeout: 10000}); expect(io.refresh?.loading).toBe(false);
    });
    it('Ошибка первого чтения оставляет рабочее действие повторной загрузки', async () => {
        io.get.mockRejectedValueOnce(new Error('Сервер недоступен')); render(); await flush(); expect(render()).toContain('Сервер недоступен'); expect(io.refresh?.loading).toBe(false);
        io.refresh!.onClick(); await flush(); expect(render()).toContain(source.repository); expect(io.get).toHaveBeenCalledTimes(2);
    });
    it('Отказ refresh оставляет последний прочитанный источник и не объявляет его свежим', async () => {
        render(); await flush(); render(); io.get.mockRejectedValueOnce(new Error('Обрыв соединения')); io.refresh!.onClick(); await flush(); const html = render();
        expect(html).toContain(source.repository); expect(html).toContain('Обрыв соединения'); expect(html).toContain('последний прочитанный источник'); expect(io.refresh?.loading).toBe(false);
    });
    it('Повторное нажатие не создаёт конкурирующее чтение; закрытие abort-ит свой запрос', async () => {
        const pending = deferred<ReturnType<typeof response>>(); io.get.mockReturnValue(pending.promise); render(); render(); io.refresh!.onClick(); expect(io.get).toHaveBeenCalledOnce();
        const signal = io.get.mock.calls[0][1].signal as AbortSignal; hooks.dispose(); expect(signal.aborted).toBe(true); pending.reject(new Error('После закрытия')); await flush();
        expect(io.get).toHaveBeenCalledOnce();
    });
    it('Поздний ответ после утраты активного владельца не публикует чужой repository', async () => {
        const pending = deferred<ReturnType<typeof response>>(); io.get.mockReturnValue(pending.promise); render(); io.active = false; pending.resolve(response()); await flush();
        expect(render()).not.toContain(source.repository);
    });
});
