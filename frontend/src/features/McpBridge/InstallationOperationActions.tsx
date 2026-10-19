import { Button, Dropdown, Menu } from 'antd';
import { useState } from 'react';
import type { IBridgeInstallation } from './api';
import type { useBridge } from './useBridge';
import { latestInstallationReport, localActionBlocker, runtimeFileBlocker } from './operationHelpers';
import { RepairInstallationModal } from './RepairInstallationModal';
import { RuntimeProbeModal } from './RuntimeProbeModal';
import { LocalVariantsModal } from './LocalVariantsModal';
import { localVariantsBlocker } from './inventoryHelpers';
import { McpConfigurationModal } from './McpConfigurationModal';
import { configurationBlocker, configurationRuntimeBlocker } from './mcpConfiguration';
import { installationProgress } from './installationProgress';

/** Дополнительные действия доступны только текущей установке; открытая модалка сохраняет исходный tuple. */
export function InstallationOperationActions({item,bridge,canManage,canView=canManage}: {item:IBridgeInstallation;bridge:ReturnType<typeof useBridge>;canManage:boolean;canView?:boolean}) {
    const [selected,setSelected] = useState<{kind:'repair'|'runtime'|'variants'|'configuration';item:IBridgeInstallation}>();
    const ready = !!(bridge.devicesReady && bridge.jobsReady && bridge.installationsReady);
    const report = latestInstallationReport(item,bridge.jobs);
    const repair = localActionBlocker(item,bridge.installations,bridge.device,bridge.jobs,ready,canManage,'local-change-plan-v1');
    const runtime = localActionBlocker(item,bridge.installations,bridge.device,bridge.jobs,ready,canManage,'runtime-probe-v1') || runtimeFileBlocker(report) || configurationRuntimeBlocker(report);
    const variants = localVariantsBlocker(item,bridge.installations,bridge.device,bridge.jobs,ready,canView);
    const configuration = configurationBlocker(item,bridge.installations,bridge.device,bridge.jobs,ready,canView,false);
    const next = installationProgress(report,bridge.jobs);
    return <>
        {canManage && next.action === 'runtime' && <Button size="small" type="primary" disabled={!!runtime} title={runtime || undefined}
            onClick={() => setSelected({kind:'runtime',item:{...item}})}>Проверить запуск</Button>}
        {canManage && next.action === 'repair' && <Button size="small" type="primary" disabled={!!repair} title={repair || undefined}
            onClick={() => setSelected({kind:'repair',item:{...item}})}>Сравнить и восстановить</Button>}
        {item.assetKind === 'mcp' && item.configurationSchemaDigest && <Button size="small" type={!report.configuration?.ready ? 'primary' : 'default'}
            disabled={!!configuration} title={configuration || undefined} onClick={() => setSelected({kind:'configuration',item:{...item}})}>
            {report.configuration?.ready ? 'Локальная настройка' : 'Настроить MCP'}
        </Button>}
        <Dropdown trigger={['click']} overlay={<Menu items={[
            {key:'repair',label:<span title={repair || undefined}>Сравнить и восстановить файлы</span>,disabled:!!repair},
            {key:'runtime',label:<span title={runtime || undefined}>Проверить запуск в OpenCode</span>,disabled:!!runtime},
            {key:'variants',label:<span title={variants || undefined}>Сохранённые локальные варианты</span>,disabled:!!variants},
        ]} onClick={({key}) => setSelected({kind:key as 'repair'|'runtime'|'variants',item:{...item}})} />}>
            <Button size="small" aria-label={`Дополнительные действия: ${item.name}`}>Ещё</Button>
        </Dropdown>
        {selected?.kind === 'repair' && <RepairInstallationModal item={selected.item} bridge={bridge} canManage={canManage} onClose={() => setSelected(undefined)} />}
        {selected?.kind === 'runtime' && <RuntimeProbeModal item={selected.item} bridge={bridge} canManage={canManage} onClose={() => setSelected(undefined)} />}
        {selected?.kind === 'variants' && <LocalVariantsModal item={selected.item} bridge={bridge} canManage={canManage} canView={canView} onClose={() => setSelected(undefined)} />}
        {selected?.kind === 'configuration' && <McpConfigurationModal item={selected.item} bridge={bridge} canManage={canManage} canView={canView} onClose={() => setSelected(undefined)} />}
    </>;
}
