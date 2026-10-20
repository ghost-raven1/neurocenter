import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BridgeDeviceCard } from '../src/features/McpBridge/BridgeDeviceCard';
import type { IBridgeDevice } from '../src/features/McpBridge/api';

const device: IBridgeDevice = { id: 'computer', name: 'Компьютер', role: 'Разработчик', fingerprint: 'fixture', online: true, lastSeen: null, report: {} };

describe('Реальные элементы управления карточки компьютера', () => {
    it.each([
        { verified: false, busy: false },
        { verified: true, busy: true },
    ])('Ant Design не разблокирует меню при verified=$verified и busy=$busy', ({ verified, busy }) => {
        const html = renderToStaticMarkup(createElement(BridgeDeviceCard, { device, selected: false, verified, busy,
            disconnecting: false, onChoose: vi.fn(), onRevoke: vi.fn() }));
        const menu = html.match(/<button\b[^>]*aria-label="Действия с компьютером Компьютер"[^>]*>/)?.[0];
        const choose = html.match(/<button\b[^>]*aria-label="Выбрать компьютер Компьютер"[^>]*>/)?.[0];
        expect(menu).toBeDefined(); expect(menu).toMatch(/\bdisabled=""/);
        expect(choose).toBeDefined(); expect(choose).toMatch(/\bdisabled=""/);
    });
});
