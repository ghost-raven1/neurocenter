import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgePairing } from '../src/features/McpBridge/BridgePairing';

const io = vi.hoisted(() => ({phase: 'connected', location: {pathname: '/start', search: '?step=1&connect=ABCDEF1234567890', hash: ''},
    replace: vi.fn(), next: undefined as (() => void) | undefined}));

vi.mock('react', async original => {
    const actual = await original<typeof import('react')>();
    return { ...actual, useState: (initial?: unknown) => {
        const [value, setValue] = actual.useState(initial);
        return [initial === 'checking' ? io.phase : initial === undefined
            ? { name: 'Мой компьютер', fingerprint: 'fixture', approved: true, expiresAt: '2026-10-19T03:00:00Z' } : value, setValue];
    } };
});
vi.mock('react-redux', () => ({ useSelector: () => 'Разработчик' }));
vi.mock('react-router-dom', () => ({
    useLocation: () => io.location,
    useHistory: () => ({ replace: io.replace }),
}));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
    return { Modal: ({children, onOk}: {children?: ReactNode; onOk(): void}) => {io.next = onOk; return content({children});}, Space: content, Spin: () => null, Typography: { Paragraph: content, Text: content },
        Alert: ({ message, description }: { message: ReactNode; description?: ReactNode }) => createElement('section', null, message, description) };
});

beforeEach(() => {vi.clearAllMocks(); io.phase = 'connected'; io.location = {pathname: '/start', search: '?step=1&connect=ABCDEF1234567890', hash: ''}; io.next = undefined;});

describe('Результат подключения компьютера', () => {
    it('Подтверждает выполненный шаг без обещания постоянного онлайн-статуса', () => {
        const html = renderToStaticMarkup(createElement(BridgePairing, { onConnected: vi.fn() }));
        expect(html).toContain('Мой компьютер');
        expect(html).toContain('Подключение подтверждено');
        expect(html).toContain('Теперь выберите общую папку проектов');
        expect(html).not.toContain('Компьютер на связи');
    });
    it('Ошибка ведёт в основной мастер, сохраняет контекст и не открывает просроченное подключение снова', () => {
        io.phase = 'error'; io.location = {pathname: '/start', search: '?legacy=1&step=2&p=prj+%E6%97%A5%E6%9C%AC&extension=rag&connect=EXPIRED&help=bridge', hash: '#computer'};
        const onConnected = vi.fn(); renderToStaticMarkup(createElement(BridgePairing, {onConnected}));
        expect(io.replace).not.toHaveBeenCalled(); expect(io.next).toBeTypeOf('function'); io.next!();
        expect(io.replace).toHaveBeenCalledOnce(); const target = new URL(io.replace.mock.calls[0][0], 'https://panel.example.test');
        expect(target.pathname).toBe('/start'); expect(target.searchParams.get('setup')).toBe('1'); expect(target.searchParams.get('step')).toBe('1');
        expect(target.searchParams.get('p')).toBe('prj 日本'); expect(target.searchParams.get('extension')).toBe('rag'); expect(target.searchParams.get('help')).toBe('bridge');
        expect(target.hash).toBe('#computer'); expect(target.searchParams.has('connect')).toBe(false);
        expect(onConnected).not.toHaveBeenCalled();
    });
});
