import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BridgePairing } from '../src/features/McpBridge/BridgePairing';

vi.mock('react', async original => {
    const actual = await original<typeof import('react')>();
    return { ...actual, useState: (initial?: unknown) => {
        const [value, setValue] = actual.useState(initial);
        return [initial === 'checking' ? 'connected' : initial === undefined
            ? { name: 'Мой компьютер', fingerprint: 'fixture', approved: true, expiresAt: '2026-10-19T03:00:00Z' } : value, setValue];
    } };
});
vi.mock('react-redux', () => ({ useSelector: () => 'Разработчик' }));
vi.mock('react-router-dom', () => ({
    useLocation: () => ({ pathname: '/start', search: '?step=1&connect=ABCDEF1234567890' }),
    useHistory: () => ({ replace: vi.fn() }),
}));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
    return { Modal: content, Space: content, Spin: () => null, Typography: { Paragraph: content, Text: content },
        Alert: ({ message, description }: { message: ReactNode; description?: ReactNode }) => createElement('section', null, message, description) };
});

describe('Результат подключения компьютера', () => {
    it('Подтверждает выполненный шаг без обещания постоянного онлайн-статуса', () => {
        const html = renderToStaticMarkup(createElement(BridgePairing, { onConnected: vi.fn() }));
        expect(html).toContain('Мой компьютер');
        expect(html).toContain('Подключение подтверждено');
        expect(html).toContain('Теперь выберите общую папку проектов');
        expect(html).not.toContain('Компьютер на связи');
    });
});
