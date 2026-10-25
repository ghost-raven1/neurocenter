import { Alert, Button, Checkbox, Select, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import type { RoleMcpSelection, RoleMcpTarget } from '../SystemRoles/types';
import { mcpTargetKey } from './mcpApi';
import { useMcpTaskDiscovery, useMcpTaskSources } from './useMcpTaskTools';

function targetOf(value: RoleMcpSelection): RoleMcpTarget { const { discoveryId: _id, tools: _tools, ...target } = value; return target; }
interface PickerProps { projectId?: string; value: RoleMcpSelection[]; disabled: boolean; canExecute: boolean; onChange(value: RoleMcpSelection[]): void; }

/** MCP access is granted only by selecting actual discovered tools, never by catalog presence. */
export function McpTaskPicker({ projectId, value, disabled, canExecute, onChange }: PickerProps): JSX.Element {
    const availability = useFeatureAvailability('system_role_mcp'), sources = useMcpTaskSources(projectId);
    const [targets, setTargets] = useState<RoleMcpTarget[]>(() => value.map(targetOf));
    const canDiscover = !!projectId && canExecute && availability.enabled && sources.data?.enabled === true && !disabled;
    const allowed = useRef(canDiscover); allowed.current = canDiscover;
    const selectedKeys = value.map(mcpTargetKey).join('|');
    useEffect(() => { setTargets(previous => { const missing = value.filter(item => !previous.some(target => mcpTargetKey(target) === mcpTargetKey(item))); return missing.length ? [...previous, ...missing.map(targetOf)] : previous; }); }, [selectedKeys]);
    const options = (sources.data?.assignments ?? []).flatMap(item => [
        { value: mcpTargetKey({ runtime: 'server', assetId: item.assetId, ...(item.assetKind === 'plugin' ? { assetKind: 'plugin' as const } : {}), version: item.version, manifest: item.manifest }), label: item.name + ' · Сервер' + (item.server.available ? '' : ' · ' + (item.server.reason || 'недоступно')),
            disabled: !item.server.available, target: { runtime: 'server', assetId: item.assetId, ...(item.assetKind === 'plugin' ? { assetKind: 'plugin' as const } : {}), version: item.version, manifest: item.manifest } as RoleMcpTarget },
        ...item.devices.map(device => { const target: RoleMcpTarget = { runtime: 'device', assetId: item.assetId, ...(item.assetKind === 'plugin' ? { assetKind: 'plugin' as const } : {}), version: item.version, manifest: item.manifest, deviceId: device.deviceId,
            bindingId: device.bindingId, instanceId: device.instanceId, configurationRevisions: device.configurationRevisions }; return { value: mcpTargetKey(target), target,
            label: item.name + ' · ' + device.name + (device.available ? '' : ' · ' + (device.reason || 'недоступно')), disabled: !device.available }; }),
    ]);
    const current = useRef({ value, disabled, limit: sources.data?.limits.selectedTools ?? 8 }); current.current = { value, disabled, limit: sources.data?.limits.selectedTools ?? 8 };
    const change = (target: RoleMcpTarget, selected?: RoleMcpSelection): void => {
        if (!sources.capture()() || current.current.disabled) return;
        const rest = current.current.value.filter(item => mcpTargetKey(item) !== mcpTargetKey(target));
        if (selected && rest.reduce((sum, item) => sum + item.tools.length, 0) + selected.tools.length > current.current.limit) return;
        onChange(selected?.tools.length ? [...rest, selected] : rest);
    };
    return <details className="service-chat__mcp"><summary>Инструменты MCP · выбрано {value.reduce((sum, item) => sum + item.tools.length, 0)}</summary>
        <Typography.Paragraph type="secondary">Выберите место исполнения, получите список инструментов и разрешите нужные для этой задачи. Открытие списка не вызывает модель. Общий предел — {sources.data?.limits.calls ?? 6} вызовов MCP.</Typography.Paragraph>
        {!projectId ? <Typography.Paragraph>Выберите проект, чтобы добавить инструменты MCP.</Typography.Paragraph> : <>
            {!availability.enabled && <Alert type="info" showIcon message={availability.reason} description="Можно убрать инструменты и продолжить задачу без MCP. Сохранённые списки доступны для чтения." />}
            {sources.error && <Alert type="warning" showIcon message={sources.error} action={<Button size="small" onClick={() => { void sources.refresh(); }}>Повторить</Button>} />}
            <label className="service-chat__history-label">Добавить источник MCP<Select aria-label="Источник инструментов MCP" value={undefined} placeholder="Сервер или мой компьютер" loading={sources.loading} disabled={!canDiscover || targets.length >= (sources.data?.limits.targets ?? 2)}
                options={options.filter(item => !targets.some(target => target.assetId === item.target.assetId)).map(({ value: key, label, disabled: unavailable }) => ({ value: key, label, disabled: unavailable }))} onChange={key => {
                    if (!allowed.current || !sources.capture()()) return; const option = options.find(item => item.value === key && !item.disabled);
                    if (option) setTargets(previous => previous.some(item => item.assetId === option.target.assetId) || previous.length >= (sources.data?.limits.targets ?? 2) ? previous : [...previous, option.target]);
                }} /></label>
            {!sources.loading && sources.data && !sources.data.assignments.length && <Typography.Paragraph>В проекте нет назначенных MCP. Добавьте MCP в каталоге; задачу можно отправить без инструментов.</Typography.Paragraph>}
        </>}
        {targets.map(target => { const key = mcpTargetKey(target), selected = value.find(item => mcpTargetKey(item) === key); return <McpTargetTools key={key} projectId={projectId} target={target} selected={selected}
            title={options.find(item => item.value === key)?.label ?? sources.data?.assignments.find(item => item.assetId === target.assetId)?.name ?? 'Выбранный MCP'}
            disabled={disabled} enabled={canDiscover} toolBudget={(sources.data?.limits.selectedTools ?? 8) - value.filter(item => mcpTargetKey(item) !== key).reduce((sum, item) => sum + item.tools.length, 0)}
            onChange={selection => change(target, selection)} onRemove={() => { if (!sources.capture()() || current.current.disabled) return; change(target); setTargets(previous => previous.filter(item => mcpTargetKey(item) !== key)); }} />; })}
    </details>;
}

function McpTargetTools({ projectId, target, selected, title, disabled, enabled, toolBudget, onChange, onRemove }: {
    projectId?: string; target: RoleMcpTarget; selected?: RoleMcpSelection; title: string; disabled: boolean; enabled: boolean; toolBudget: number;
    onChange(value?: RoleMcpSelection): void; onRemove(): void;
}): JSX.Element {
    const discovery = useMcpTaskDiscovery(projectId, target, enabled, selected?.discoveryId), allowed = useRef(enabled); allowed.current = enabled;
    const tools = discovery.discovery?.state === 'ready' ? discovery.discovery.tools : [];
    const chosen = selected?.tools.map(tool => tool.name + ':' + tool.schemaDigest) ?? [];
    return <section className="service-chat__mcp-target"><div><Typography.Text strong>{title} · {target.runtime === 'server' ? 'Сервер' : 'Мой компьютер'}</Typography.Text> <Button size="small" disabled={disabled} onClick={onRemove}>Убрать MCP</Button></div>
        <Space wrap><Button size="small" disabled={disabled || !enabled || discovery.busy || discovery.discovery?.state === 'pending'} loading={discovery.busy} onClick={() => {
            if (!allowed.current || disabled || !discovery.capture()()) return; onChange(); void discovery.discover();
        }}>{discovery.discovery?.state === 'ready' ? 'Обновить список инструментов' : 'Получить список инструментов'}</Button>
            {discovery.requestId && <Button size="small" disabled={discovery.busy} onClick={() => { void discovery.read(); }}>Проверить список</Button>}</Space>
        {discovery.error && <Alert type="warning" showIcon message={discovery.error} description="Задачу можно продолжить без этого MCP. Повтор проверяет прежний запрос." />}
        {discovery.discovery?.state === 'pending' && <Typography.Paragraph role="status">Получаем список с выбранного источника…</Typography.Paragraph>}
        {discovery.discovery?.state === 'failed' && <Alert type="warning" showIcon message={discovery.discovery.message || 'Источник не предоставил список инструментов.'} />}
        {!!tools.length && <Checkbox.Group aria-label={'Разрешённые инструменты ' + title} value={chosen} disabled={disabled || !enabled || discovery.busy} options={tools.map(tool => ({ value: tool.name + ':' + tool.schemaDigest,
            label: tool.name + (tool.description ? ' · ' + tool.description : ''), disabled: !chosen.includes(tool.name + ':' + tool.schemaDigest) && chosen.length >= toolBudget }))} onChange={keys => {
            if (!allowed.current || disabled || !discovery.discovery || !discovery.canSelect(discovery.discovery.id) || keys.length > toolBudget && keys.length >= chosen.length) return;
            const selectedTools = tools.filter(tool => keys.includes(tool.name + ':' + tool.schemaDigest)).map(({ name, schemaDigest }) => ({ name, schemaDigest }));
            onChange({ ...target, discoveryId: discovery.discovery.id, tools: selectedTools });
        }} />}
        {discovery.discovery?.state === 'ready' && !tools.length && <Typography.Paragraph>Источник подтвердил пустой список инструментов.</Typography.Paragraph>}
        {!!tools.length && <details><summary>Схемы доступных инструментов</summary>{tools.map(tool => <details key={tool.name}><summary>{tool.name}</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}</details>}
    </section>;
}
