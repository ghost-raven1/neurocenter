// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TGlobalProvidersIssue } from '@neurocenter/opencode-local-providers';
import { LocalOpenCodeProvidersStep } from '../LocalOpenCodeProvidersStep';

const { useLocalProviders } = vi.hoisted(() => ({ useLocalProviders: vi.fn() }));
vi.mock('../hooks/useLocalProviders', () => ({ useLocalProviders }));
let root: Root;
let container: HTMLDivElement;
const start = vi.fn(),
    refresh = vi.fn(),
    onContinue = vi.fn();
function view(issues: TGlobalProvidersIssue[], version?: string, providers: unknown[] = []) {
    useLocalProviders.mockReturnValue({
        state: {
            busy: false,
            denied: false,
            storageError: '',
            error: '',
            jobs: {},
            replayKinds: [],
            inventory: { providers, issues },
        },
        controller: { start, refresh },
        canRead: true,
        canInspect: true,
        canOpen: true,
    });
    return <LocalOpenCodeProvidersStep bridge={{} as never} enabled cliVersion={version} onContinue={onContinue} />;
}
const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label)!;
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});
describe('partial provider inventory', () => {
    it('shows separate causes and does not call an unreadable list an empty configuration', async () => {
        await act(async () => root.render(view(['invalid-json', 'environment-override'], '1.14.48')));
        expect(container.textContent).toContain('Полный список провайдеров не получен');
        expect(container.textContent).toContain('Исправьте синтаксис');
        expect(container.textContent).toContain('переопределения окружения');
        expect(container.textContent).not.toContain('пока не настроены');
        expect(button('Использовать текущую настройку').disabled).toBe(true);
        expect(start).not.toHaveBeenCalled();
        await act(async () => button('Перечитать провайдеров').click());
        expect(start).toHaveBeenCalledWith('inspect-opencode-global-providers');
    });
    it.each(['1.19.5', '2.1.2'])('keeps manual continuation truthful and writing blocked for %s', async (version) => {
        await act(async () => root.render(view(['read-failed'], version)));
        expect(button('Настроить на компьютере').disabled).toBe(true);
        expect(button('Продолжить с настройкой OpenCode').disabled).toBe(false);
        expect(container.textContent).toContain('Можно продолжить');
        expect(container.textContent).not.toContain('переход ждёт полного чтения');
        if (version.startsWith('2.')) expect(container.textContent).toContain('базе своего сервера');
        await act(async () => button('Продолжить с настройкой OpenCode').click());
        expect(onContinue).toHaveBeenCalledOnce();
        expect(start).not.toHaveBeenCalled();
    });
    it('allows the supported complete setting without opening a setup session', async () => {
        await act(async () =>
            root.render(
                view([], '1.14.48', [
                    { id: 'example', enabled: true, hasConfiguration: true, authentication: 'api', modelIds: [] },
                ]),
            ),
        );
        expect(button('Использовать текущую настройку').disabled).toBe(false);
        await act(async () => button('Использовать текущую настройку').click());
        expect(onContinue).toHaveBeenCalledOnce();
        expect(start).not.toHaveBeenCalled();
    });
    it('keeps an empty supported inventory distinct from failed reading', async () => {
        await act(async () => root.render(view([], '1.14.48')));
        expect(container.textContent).toContain('В глобальных файлах провайдеры пока не найдены');
        expect(container.textContent).not.toContain('Полный список провайдеров не получен');
        expect(button('Использовать текущую настройку').disabled).toBe(true);
    });
    it('does not confirm readiness for an unknown CLI version', async () => {
        await act(async () =>
            root.render(
                view([], undefined, [
                    { id: 'example', enabled: true, hasConfiguration: true, authentication: 'api', modelIds: [] },
                ]),
            ),
        );
        expect(button('Использовать текущую настройку').disabled).toBe(true);
        expect(container.textContent).toContain('Готовность провайдеров пока не подтверждена');
    });
});
