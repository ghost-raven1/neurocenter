import {Descriptions,Tag,Typography} from 'antd';
import type {IProjectAsset} from '../../core/api/interfaces';
import type {useBridge} from '../../features/McpBridge/useBridge';
import {installationProgress} from '../../features/McpBridge/installationProgress';
import {latestInstallationReport} from '../../features/McpBridge/operationHelpers';
import {setupBinding} from './projectSetupModel';

/** Measured facts stay separate from the open navigation step and the installer's terminal output. */
export function SetupProgress({bridge,projectId,assets,catalogReady}:{bridge:ReturnType<typeof useBridge>;projectId?:string;assets:readonly IProjectAsset[];catalogReady:boolean}){
    const binding=setupBinding(bridge,projectId),device=bridge.device;
    const observed=!!binding&&bridge.jobsReady&&bridge.installationsReady&&catalogReady;
    const installations=observed?assets.map(asset=>bridge.installations.find(item=>item.projectId===projectId&&item.deviceId===device?.id&&item.bindingId===binding.bindingId
        &&item.assetId===asset.assetId&&item.assetKind===asset.assetKind&&item.version===asset.version&&item.manifest===asset.manifest&&!item.bindingChanged&&item.isCurrentBinding!==false)):[];
    const installed=installations.filter(Boolean).length,checked=installations.filter(item=>item&&installationProgress(latestInstallationReport(item,bridge.jobs),bridge.jobs).state==='passed').length;
    return <section aria-label="Состояние настройки окружения"><Typography.Title level={5}>Состояние окружения</Typography.Title>
        <Descriptions size="small" column={1}>
            <Descriptions.Item label="OpenCode">Результат установки — в терминале. Версия CLI пока не проверена сайтом: <Typography.Text code>opencode --version</Typography.Text>.</Descriptions.Item>
            <Descriptions.Item label="Мост"><Tag color={bridge.devicesReady&&device?.online?'green':'orange'}>{!bridge.devicesReady?'Статус не подтверждён':!device?'Ожидаем подключения или выбора компьютера':device.online?'Компьютер подключён':'Компьютер не в сети'}</Tag>{bridge.errors.devices}</Descriptions.Item>
            <Descriptions.Item label="Папка проекта">{binding?<Tag color="green">Подтверждена · {binding.folderName}</Tag>:projectId?'Папка не подтверждена для выбранного компьютера':'Выберите проект'}</Descriptions.Item>
            <Descriptions.Item label="Инструменты">{!projectId?'Выберите проект':!observed?'Установки и проверки ещё не подтверждены':!assets.length?'Проекту пока не назначены инструменты':`Квитанции установки: ${installed}/${assets.length} · диагностика пройдена: ${checked}/${assets.length}`}</Descriptions.Item>
            <Descriptions.Item label="Агенты и модель">Применение профилей и результаты их проверок доступны на шаге «Агенты и инструменты». Ответ модели проверяется отдельным явным запуском.</Descriptions.Item>
        </Descriptions>
    </section>;
}
