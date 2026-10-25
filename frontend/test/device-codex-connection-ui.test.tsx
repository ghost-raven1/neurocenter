// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DeviceCodexConnectionModal} from '../src/features/ModelCatalog/DeviceCodexConnectionModal';
import baseApi from '../src/core/api/base';
import type {ICatalogModel, IDeviceCodexConnection} from '../src/features/ModelCatalog/types';

const ui = vi.hoisted(() => ({owner: 'admin-a', close: vi.fn(), captureOwner: (): (() => boolean) => {
    const owner: string = ui.owner; return () => owner === ui.owner;
}}));
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: ui.owner, captureOwner: ui.captureOwner})}));

const model: ICatalogModel = {id: 'codex-one', name: 'Codex проекта', description: '', capability: 'chat', runtime: 'device-codex', model: 'codex-fixture', modelVersion: 'v1', dimension: null, manifestSha256: null, source: 'custom', revision: 3, createdAt: '', updatedAt: ''};
const ready: IDeviceCodexConnection = {deviceId: 'computer-one', deviceName: 'Рабочий Mac', scope: 'project', projectId: 'project-one', connectionRevision: 1, state: 'ready', message: 'Компьютер отвечает, Codex доступен'};
let container: HTMLDivElement, root: Root;

beforeEach(() => {
    vi.clearAllMocks(); ui.owner = 'admin-a'; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', (query: string) => ({matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false}));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {await act(async () => {root.unmount();}); container.remove(); vi.unstubAllGlobals();});

describe('Повторная проверка компьютера Codex', () => {
    it('После отказа повторной проверки помечает прежний успешный ответ как устаревший', async () => {
        vi.mocked(baseApi.get).mockResolvedValueOnce({data: ready});
        await act(async () => {root.render(createElement(DeviceCodexConnectionModal, {model, onClose: ui.close}));});
        expect(document.querySelector('.ant-alert-success')?.textContent).toContain(ready.message);
        vi.mocked(baseApi.get).mockRejectedValueOnce(new Error('Компьютер сейчас не отвечает'));
        const recheck = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Проверить компьютер')!;
        expect(recheck).toBeTruthy();
        await act(async () => {recheck.click();});
        expect(baseApi.get).toHaveBeenCalledTimes(2);
        expect(document.body.textContent).toContain('Компьютер сейчас не отвечает');
        expect(document.body.textContent).toContain('Рабочий Mac');
        expect(document.querySelector('.ant-alert-success')).toBeNull();
        expect(document.querySelector('.ant-alert-warning')?.textContent).toMatch(/предыдущ|устарел|не подтвержд/i);
        expect(recheck.disabled).toBe(false); expect(ui.close).not.toHaveBeenCalled();
    });
});
