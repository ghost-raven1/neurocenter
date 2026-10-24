import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { modalAntd, uiNode } from './modal-actions.fixture';
import type { RoleMcpSelection } from '../src/features/SystemRoles/types';
const h = await vi.hoisted(async () => {
    const { adminSetupHooks } = await import('./admin-setup-hooks.fixture'), { modalUi } = await import('./modal-actions.fixture');
    return { hooks: adminSetupHooks(), ui: modalUi(), enabled: true, selection: [] as RoleMcpSelection[], discovery: undefined as any, sources: {} as any, changed: vi.fn(), discover: vi.fn(), read: vi.fn(), actor: 'alice' };
});
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: h.hooks.state, useRef: h.hooks.ref, useEffect: h.hooks.effect }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({ useFeatureAvailability: () => ({ enabled: h.enabled, reason: 'MCP выключено' }) }));
vi.mock('../src/features/SystemRoleChat/useMcpTaskTools', () => ({
    useMcpTaskSources: () => { const actor = h.actor; return { data: h.sources, loading: false, error: '', refresh: vi.fn(), capture: () => () => h.actor === actor }; },
    useMcpTaskDiscovery: (_project: string, target: unknown) => { const actor = h.actor; return { discovery: h.discovery && { ...h.discovery, target }, requestId: h.discovery?.id, busy: false, error: '', discover: h.discover, read: h.read,
        capture: () => () => h.actor === actor, canSelect: () => h.actor === actor && h.discovery?.state === 'ready' }; },
}));
vi.mock('antd', async () => {
    const element = (await import('react')).createElement, ui = modalAntd(h.ui, element); return { ...ui, Checkbox: Object.assign(ui.Checkbox, { Group: ui.Checkbox }) };
});
import { McpTaskPicker } from '../src/features/SystemRoleChat/McpTaskPicker';
const render = (projectId: string | undefined = 'prj-one') => {
    h.hooks.begin(); h.ui.nodes = []; const html = renderToStaticMarkup(createElement(McpTaskPicker, { projectId, value: h.selection, disabled: false, canExecute: true,
        onChange: value => { h.selection = value; h.changed(value); } })); h.hooks.commit(); return html;
};
const source = () => h.ui.nodes.find(node => node.kind === 'Select' && node.props['aria-label'] === 'Источник инструментов MCP')!.props;
const group = () => h.ui.nodes.find(node => node.kind === 'Checkbox' && node.props['aria-label'])!.props;
const button = (text: string) => uiNode(h.ui, 'Button', text);
beforeEach(() => {
    h.hooks.dispose(); vi.clearAllMocks(); h.enabled = true; h.actor = 'alice'; h.selection = []; h.discovery = undefined;
    h.sources = { enabled: true, limits: { targets: 2, selectedTools: 8, calls: 6 }, assignments: [{ assetId: 'asset-one', name: 'Project search', version: 4, manifest: 'a'.repeat(64), server: { available: true },
        devices: [{ deviceId: 'device-one', name: 'MacBook', available: true, bindingId: 'binding-one', instanceId: 'instance-one', configurationRevisions: [{ assetId: 'asset-one', manifest: 'a'.repeat(64), revision: 'revision-one' }] }] }] };
});
afterEach(() => { h.hooks.dispose(); });
const chooseServer = () => { render(); source().onChange(source().options[0].value); render(); };
const ready = () => { h.discovery = { id: 'discovery-one', state: 'ready', message: 'Actual result', tools: [{ name: 'search', description: 'Actual tool', schemaDigest: 'b'.repeat(64), inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] }; render(); };
it('offers server MCP without requiring a computer and never selects or discovers all catalog tools implicitly', () => {
    render(); expect(source().options[0]).toMatchObject({ label: 'Project search · Сервер', disabled: false }); expect(h.discover).not.toHaveBeenCalled(); expect(h.selection).toEqual([]);
    source().onChange(source().options[0].value); render(); button('Получить список').onClick(); expect(h.discover).toHaveBeenCalledOnce(); expect(h.selection).toEqual([]); ready();
    expect(group().value).toEqual([]); expect(group().options).toEqual([expect.objectContaining({ label: 'search · Actual tool' })]); expect(h.selection).toEqual([]);
    group().onChange(['search:' + 'b'.repeat(64)]); expect(h.selection).toEqual([{ runtime: 'server', assetId: 'asset-one', version: 4, manifest: 'a'.repeat(64), discoveryId: 'discovery-one', tools: [{ name: 'search', schemaDigest: 'b'.repeat(64) }] }]);
});
it('device selection carries only the chosen own computer and its binding/configuration pins', () => {
    render(); source().onChange(source().options.find((item: { label: string }) => item.label.includes('MacBook')).value); render(); ready(); group().onChange(['search:' + 'b'.repeat(64)]);
    expect(h.selection[0]).toMatchObject({ runtime: 'device', deviceId: 'device-one', bindingId: 'binding-one', instanceId: 'instance-one', configurationRevisions: [{ revision: 'revision-one' }], discoveryId: 'discovery-one' });
});
it.each(['server', 'device'])('retains the verified plugin producer kind in the explicit %s selection', runtime => {
    h.sources.assignments[0].assetKind = 'plugin'; render(); source().onChange(source().options[runtime === 'server' ? 0 : 1].value); render(); ready(); group().onChange(['search:' + 'b'.repeat(64)]);
    expect(h.selection[0]).toMatchObject({ assetKind: 'plugin', runtime, assetId: 'asset-one' });
});
it('one asset cannot be added again through another runtime before or after a tool is chosen', () => {
    render(); const server = source().options[0].value, computer = source().options[1].value, staleAdd = source().onChange;
    staleAdd(server); staleAdd(computer); render(); expect(source().options).toEqual([]); expect(h.ui.nodes.filter(node => node.kind === 'Button' && node.text.includes('Получить список'))).toHaveLength(1);
});
it('failed discovery leaves tool permissions empty and gives an explicit way to continue without that MCP', () => {
    chooseServer(); h.discovery = { id: 'discovery-one', state: 'failed', message: 'Компьютер не подключён', tools: [] }; expect(render()).toContain('Компьютер не подключён'); expect(h.selection).toEqual([]);
    button('Убрать MCP').onClick(); render(); expect(h.ui.nodes.some(node => node.kind === 'Button' && node.text.includes('Получить список'))).toBe(false);
});
it('feature OFF fences retained tool-grant handlers while allowing removal of selected MCP', () => {
    chooseServer(); ready(); const old = group().onChange; old(['search:' + 'b'.repeat(64)]); render(); const snapshot = structuredClone(h.selection); h.changed.mockClear();
    h.enabled = false; render(); old(['search:' + 'b'.repeat(64)]); expect(h.changed).not.toHaveBeenCalled(); expect(h.selection).toEqual(snapshot); expect(group().disabled).toBe(true);
    button('Убрать MCP').onClick(); expect(h.selection).toEqual([]);
});
it('an actor switch fences retained actual-tool handlers', () => {
    chooseServer(); ready(); const old = group().onChange; h.actor = 'bob'; old(['search:' + 'b'.repeat(64)]); expect(h.selection).toEqual([]);
});
it('no project shows a setup step and keeps MCP optional', () => {
    expect(render('')).toContain('Выберите проект'); expect(h.ui.nodes.some(node => node.kind === 'Select')).toBe(false); expect(h.discover).not.toHaveBeenCalled();
});
