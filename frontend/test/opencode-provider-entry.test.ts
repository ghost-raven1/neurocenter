import './feature-flags-enabled';
import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelCard} from '../src/features/ModelCatalog/ModelCard';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';

const ui = vi.hoisted(() => ({buttons: new Map<string, {disabled?: boolean; onClick?: () => void}>()}));
vi.mock('../src/features/ModelCatalog/ModelHosting', () => ({ModelHosting: () => null}));
vi.mock('../src/features/AssetManagement/ArchiveAssetButton', () => ({ArchiveAssetButton: () => null}));
vi.mock('@ant-design/icons', () => ({CloudOutlined: () => null, DatabaseOutlined: () => null, DeleteOutlined: () => null, EditOutlined: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Tag: content, Tooltip: content, Typography: {Paragraph: content, Text: content},
        Button: (props: {children?: ReactNode; disabled?: boolean; onClick?: () => void}) => {ui.buttons.set(String(props.children), props); return null;}};
});
const model: ICatalogModel = {id: 'model-api', name: 'Внешний чат', description: '', capability: 'chat', runtime: 'remote-openai',
    model: 'manual/model-id', manifestSha256: null, verificationSha256: 'a'.repeat(64), modelVersion: 'v1', dimension: null,
    source: 'custom', revision: 1, createdAt: '', updatedAt: '', modelPin: 'b'.repeat(64)};
function render(patch: Partial<Parameters<typeof ModelCard>[0]> = {}) {
    const setup = vi.fn();
    const props: Parameters<typeof ModelCard>[0] & {onSetupProvider: () => void} = {model, assigned: true, projectSelected: true, canAssign: true,
        canHost: true, busy: false, onAssign: vi.fn(), onView: vi.fn(), onConfigure: vi.fn(), onSetupProvider: setup, ...patch};
    renderToStaticMarkup(createElement(ModelCard, props)); return setup;
}
beforeEach(() => ui.buttons.clear());

describe('Вход из серверной модели в отдельную локальную настройку OpenCode', () => {
    it('Назначенная API chat модель предлагает явную настройку OpenCode без экспорта ключа', () => {
        const setup = render(); const action = ui.buttons.get('Настроить в OpenCode');
        expect(action).toBeDefined(); expect(action!.disabled).not.toBe(true); action!.onClick!(); expect(setup).toHaveBeenCalledOnce();
        expect(ui.buttons.has('Настроить API')).toBe(true);
    });
    it('Assigned Ollama chat and vision cards expose the same explicit local setup action', () => {
        for (const capability of ['chat', 'vision'] as const) {
            ui.buttons.clear(); const setup = render({model: {...model, runtime: 'remote-ollama', capability}});
            const action = ui.buttons.get('Настроить в OpenCode'); expect(action).toBeDefined(); action!.onClick!(); expect(setup).toHaveBeenCalledOnce();
        }
    });
    it.each([
        {assigned: false}, {projectSelected: false}, {canAssign: false},
        {model: {...model, capability: 'embedding' as const, dimension: 4}},
        {model: {...model, runtime: 'ollama' as const}}, {model: {...model, archivedAt: '2026-10-22'}},
    ])('Не обещает локальную настройку неподходящему контексту: %j', patch => {
        render(patch); expect(ui.buttons.has('Настроить в OpenCode')).toBe(false);
    });
    it('Неподтверждённое изменение каталога блокирует кнопку', () => {
        render({disabled: true}); expect(ui.buttons.get('Настроить в OpenCode')!.disabled).toBe(true);
    });
});
