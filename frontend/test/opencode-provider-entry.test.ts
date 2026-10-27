// @vitest-environment jsdom
import './feature-flags-enabled';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelCard} from '../src/features/ModelCatalog/ModelCard';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';

vi.mock('../src/features/ModelCatalog/ModelHosting', () => ({ModelHosting: () => null}));
vi.mock('../src/features/AssetManagement/ArchiveAssetButton', () => ({ArchiveAssetButton: () => null}));
vi.mock('@ant-design/icons', () => ({CloudOutlined: () => null, DatabaseOutlined: () => null, DeleteOutlined: () => null, EditOutlined: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Space: content, Tag: content, Tooltip: content, Typography: {Paragraph: content, Text: content},
        Button: ({children, disabled, onClick, 'aria-label': label}: {children?: ReactNode; disabled?: boolean; onClick?: () => void; 'aria-label'?: string}) =>
            createElement('button', {type: 'button', disabled, onClick, 'aria-label': label}, children)};
});
const model: ICatalogModel = {id: 'model-api', name: 'Внешний чат', description: '', capability: 'chat', runtime: 'remote-openai',
    model: 'manual/model-id', manifestSha256: null, verificationSha256: 'a'.repeat(64), modelVersion: 'v1', dimension: null,
    source: 'custom', revision: 1, createdAt: '', updatedAt: '', modelPin: 'b'.repeat(64)};
let root: Root, container: HTMLDivElement;
function render(patch: Partial<Parameters<typeof ModelCard>[0]> = {}) {
    const setup = vi.fn();
    const props: Parameters<typeof ModelCard>[0] & {onSetupProvider: () => void} = {model, assigned: true, projectSelected: true, canAssign: true,
        canHost: true, busy: false, onAssign: vi.fn(), onView: vi.fn(), onConfigure: vi.fn(), onSetupProvider: setup, ...patch};
    act(() => root.render(createElement(ModelCard, props))); return setup;
}
const localSetupButton = (): HTMLButtonElement | undefined => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Настроить в OpenCode');
/** Exercise the real card disclosure and its DOM action, rather than calling captured component props. */
function openOtherActions(): HTMLDetailsElement {
    const details = container.querySelector<HTMLDetailsElement>('details.model-card__more')!;
    expect(details).not.toBeNull(); expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary.getAttribute('aria-label')).toBe(`Другие действия с моделью ${model.name}`);
    act(() => summary.click()); expect(details.open).toBe(true); return details;
}
beforeEach(() => {vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);});
afterEach(() => {act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();});

describe('Вход из серверной модели в отдельную локальную настройку OpenCode', () => {
    it('Назначенная API chat модель предлагает явную настройку OpenCode без экспорта ключа', () => {
        const setup = render(); expect(setup).not.toHaveBeenCalled();
        const details = openOtherActions(), action = localSetupButton();
        expect(action).toBeDefined(); expect(details.contains(action!)).toBe(true); expect(action!.disabled).toBe(false);
        expect(setup).not.toHaveBeenCalled(); act(() => action!.click()); expect(setup).toHaveBeenCalledOnce();
        expect(details.textContent).toContain('Настроить API');
    });
    it.each(['chat', 'vision'] as const)('Assigned Ollama %s card exposes the same explicit local setup action', capability => {
        const setup = render({model: {...model, runtime: 'remote-ollama', capability}});
        const details = openOtherActions(), action = localSetupButton();
        expect(action).toBeDefined(); expect(details.contains(action!)).toBe(true); expect(setup).not.toHaveBeenCalled();
        act(() => action!.click()); expect(setup).toHaveBeenCalledOnce();
    });
    it.each([
        {assigned: false}, {projectSelected: false}, {canAssign: false},
        {model: {...model, capability: 'embedding' as const, dimension: 4}},
        {model: {...model, runtime: 'ollama' as const}}, {model: {...model, archivedAt: '2026-10-22'}},
    ])('Не обещает локальную настройку неподходящему контексту: %j', patch => {
        const setup = render(patch); openOtherActions(); expect(localSetupButton()).toBeUndefined(); expect(setup).not.toHaveBeenCalled();
    });
    it('Неподтверждённое изменение каталога блокирует кнопку', () => {
        const setup = render({disabled: true}); openOtherActions(); const action = localSetupButton();
        expect(action!.disabled).toBe(true); act(() => action!.click()); expect(setup).not.toHaveBeenCalled();
    });
});
