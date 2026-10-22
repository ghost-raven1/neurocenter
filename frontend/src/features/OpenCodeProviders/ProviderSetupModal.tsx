import {Alert, Button, Modal, Select, Space, Steps, Tag, Typography} from 'antd';
import {useState} from 'react';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {artifactTargets} from '../McpBridge/runtimeArtifacts';
import type {useBridge} from '../McpBridge/useBridge';
import type {ICatalogModel} from '../ModelCatalog/types';
import {providerModelCompatibilityReason, providerModelEligible, providerSetupTarget} from './model';
import type {IProviderSetupSelection, OpenCodeProviderKind} from './types';
import {useCodexSupply} from './useCodexSupply';
import {useProviderSetup} from './useProviderSetup';
import './ProviderSetup.less';

export interface IProviderSetupModalProps {
    bridge: ReturnType<typeof useBridge>; projectId: string; projectName?: string; models: ICatalogModel[];
    initialModelId?: string; canPrepareConnector?: boolean; canManage: boolean; catalogReady: boolean; catalogError?: string;
    onReloadModels(): void; onClose(): void; onConfigured?(): void;
}

/** Website selects a public intent; credentials and official login stay in the computer's local wizard. */
export function ProviderSetupModal(props: IProviderSetupModalProps): JSX.Element {
    const {bridge, projectId, projectName, models, canManage, onClose} = props;
    const general = useFeatureAvailability('opencode_providers'), codex = useFeatureAvailability('codex_connector');
    const buildFlag = useFeatureAvailability('tool_builds', 'tool_catalog', 'codex_connector');
    const [kind, setKind] = useState<OpenCodeProviderKind>('openai-compatible');
    const [modelId, setModelId] = useState(props.initialModelId ?? '');
    const eligible = models.filter(providerModelEligible), model = eligible.find(item => item.id === modelId);
    const selectedCard = models.find(item => item.id === modelId);
    const compatibility = selectedCard ? providerModelCompatibilityReason(selectedCard) : !eligible.length ? models.map(providerModelCompatibilityReason).find(Boolean) : '';
    const target = providerSetupTarget(bridge, projectId);
    const modelReason = kind === 'openai-compatible' ? !props.catalogReady ? props.catalogError || 'Дождитесь актуального каталога моделей.'
        : !model ? compatibility || 'Выберите назначенную проекту проверенную API-модель для чата.' : '' : '';
    const runtimeTarget = bridge.device?.report.runtimeArtifactTarget;
    const platformReason = kind === 'codex-bridge' && (!runtimeTarget || !artifactTargets.includes(runtimeTarget as typeof artifactTargets[number]))
        ? 'Платформа компьютера не подтверждена. Обновите мост и перечитайте подключение.' : '';
    const readReason = !canManage ? 'Настройка доступна администратору проекта.' : target.reason || modelReason || platformReason;
    const flag = kind === 'codex-bridge' ? codex : general;
    const writeReason = readReason || !general.enabled && general.reason || !flag.enabled && flag.reason || '';
    const supply = useCodexSupply(kind === 'codex-bridge' && !!props.canPrepareConnector, !readReason && buildFlag.enabled, readReason || buildFlag.reason);
    const supplyReason = kind === 'codex-bridge' && props.canPrepareConnector && supply.supply?.state === 'ready' && runtimeTarget
        && !supply.supply.targets?.includes(runtimeTarget) ? 'Для выбранной платформы нет готового коннектора. Попросите администратора проверить поставку.' : '';
    const selection: IProviderSetupSelection | undefined = target.target && !modelReason ? kind === 'codex-bridge'
        ? {...target.target, providerKind: kind} : model ? {...target.target, providerKind: kind, catalogModelId: model.id, expectedModelPin: model.modelPin!} : undefined : undefined;
    const operation = useProviderSetup({bridge, selection, canRead: !readReason, canWrite: !writeReason && !supplyReason, writeReason: writeReason || supplyReason});
    const preparingSupply = kind === 'codex-bridge' && props.canPrepareConnector && supply.supply?.state !== 'ready';
    const supplyBusy = supply.busy || supply.supply?.state === 'building';
    const primaryDisabled = preparingSupply ? !!readReason || supplyBusy || supply.supply?.state === 'conflict' || (supply.supply?.state === 'missing' || supply.unknown) && !buildFlag.enabled : !!writeReason || !!supplyReason || operation.unknown;
    const primary = () => {if (preparingSupply) {if (supply.supply?.state === 'missing' || supply.unknown) void supply.build(); else void supply.reload();} else operation.open();};
    const primaryLabel = !preparingSupply ? 'Открыть настройку на компьютере' : supply.supply?.state === 'missing' || supply.unknown ? 'Подготовить коннектор Codex' : supplyBusy ? 'Подготавливаем коннектор Codex' : 'Проверить поставку Codex';
    const locked = operation.busy || operation.pending;
    const ready = !readReason && !supplyReason && operation.status?.ready === true;
    const bridgeRepair = !!bridge.device && (bridge.device.requiresReconnect || bridge.device.report.protocolVersion !== 2
        || !bridge.device.report.capabilities?.includes('opencode-providers-v1') || !!platformReason);
    const modelsUrl = `/projects/${encodeURIComponent(projectId)}?tab=store&catalogTab=models`;
    const binding = bridge.device?.report.bindings?.find(item => item.projectId === projectId && item.valid !== false);
    return <Modal open title="Настроить провайдера в OpenCode" width={640} footer={null} onCancel={onClose} className="provider-setup">
        <Space direction="vertical" size={16} className="provider-setup__content">
            <Steps size="small" current={ready ? 2 : operation.opened ? 1 : 0} items={[{title: 'Компьютер'}, {title: 'Локальная настройка'}, {title: 'Готовность'}]} />
            <Typography.Text>Проект: <strong>{projectName || projectId}</strong></Typography.Text>
            <label>Компьютер<Select aria-label="Компьютер для провайдера OpenCode" value={bridge.device?.id} placeholder="Выберите компьютер" disabled={locked}
                onChange={bridge.choose} options={bridge.devices.map(item => ({value: item.id, label: item.name || 'Компьютер без имени'}))} /></label>
            {binding && <Typography.Text type="secondary">Папка: {binding.folderName}</Typography.Text>}
            <label>Подключение<Select aria-label="Тип провайдера OpenCode" value={kind} disabled={locked} onChange={setKind}
                options={[{value: 'openai-compatible', label: 'OpenAI-совместимый API'}, {value: 'codex-bridge', label: 'Codex Bridge — локальный вход'}]} /></label>
            {kind === 'openai-compatible' ? <>
                <label>Модель проекта<Select aria-label="API-модель для OpenCode" value={model?.id} placeholder="Выберите API-модель" disabled={locked}
                    onChange={setModelId} options={eligible.map(item => ({value: item.id, label: `${item.name} · ${item.model}`}))} /></label>
                <Typography.Text type="secondary">Параметры и ключ вводятся в локальном окне на выбранном компьютере.</Typography.Text>
            </> : <Typography.Text type="secondary">Войдите в Codex на выбранном компьютере: используйте текущий вход или официальный экран.</Typography.Text>}
            {bridge.device?.online === false && <Alert type="info" showIcon message="Компьютер не в сети" description="Запрос останется в очереди. Включите мост на выбранном компьютере; локальный мастер откроется там." />}
            {operation.opened && <Alert role="status" type="success" showIcon message="Локальный мастер открыт" description={`Завершите настройку на компьютере «${bridge.device?.name}», затем проверьте готовность.`} />}
            <div aria-live="polite"><Tag color={ready ? 'green' : 'gold'}>{ready ? 'Настройки проверены' : operation.status ? 'Требуется локальная настройка' : 'Готовность ещё не проверена'}</Tag>
                {operation.status && <Typography.Text type="secondary">{operation.status.state === 'conflict' ? 'Локальные параметры отличаются. Откройте мастер и проверьте их.'
                    : operation.status.state === 'login-required' ? 'Завершите вход Codex на компьютере.' : operation.status.state === 'unavailable' ? 'Локальная проверка недоступна. Проверьте мост и повторите.' : ''}</Typography.Text>}</div>
            {operation.status && !!operation.status.missingFields.length && <Typography.Text type="secondary">Осталось заполнить в локальном мастере: {operation.status.missingFields.map(field => ({baseUrl: 'адрес API', credential: 'ключ', login: 'вход Codex'})[field]).join(', ')}.</Typography.Text>}
            {operation.job && operation.pending && <Alert role="status" showIcon type="info" message="Ожидаем подтверждения от выбранного компьютера" />}
            {readReason && <Alert type="warning" showIcon message={readReason} action={<Space wrap>
                {bridgeRepair && <Button href="/start?step=1">Настроить мост</Button>}
                {kind === 'openai-compatible' && modelReason && <Button href={modelsUrl}>Открыть модели проекта</Button>}
                {kind === 'openai-compatible' && !props.catalogReady && <Button onClick={props.onReloadModels}>Обновить модели</Button>}
            </Space>} />}
            {!readReason && writeReason && <Alert type="info" showIcon message={writeReason} description="Чтение готовности и уже принятые задания остаются доступны." action={<Button onClick={() => {void flag.refresh();}}>Проверить доступность</Button>} />}
            {kind === 'codex-bridge' && props.canPrepareConnector && (supply.error || supplyReason || supply.supply?.state === 'conflict') && <Alert type="warning" showIcon
                message={supply.error || supplyReason || 'Найдено несколько поставок или сборок. Новая сборка не отправлена.'} description="Проверьте состояние поставки в подробностях и повторите действие." />}
            {(operation.error || operation.unknown) && <Alert role="alert" type="error" showIcon message={operation.error || 'Ответ исходного запроса не подтверждён.'}
                action={operation.unknown && <Button disabled={locked || !!readReason || operation.retryRequiresWrite && !!writeReason} onClick={operation.retry}>Повторить запрос</Button>} />}
            <Space wrap>
                <Button type="primary" disabled={locked || primaryDisabled} loading={operation.busy || preparingSupply && supplyBusy} onClick={primary}>{primaryLabel}</Button>
                <Button disabled={locked || !!readReason} onClick={operation.check}>Проверить готовность</Button>
            </Space>
            {ready && <Alert type="success" showIcon message={kind === 'codex-bridge' ? 'Модель настроена в OpenCode' : 'Провайдер настроен'}
                description={kind === 'codex-bridge' ? 'Откройте новую сессию OpenCode в выбранной папке и выберите модель Codex. Успешный запрос к модели проверяется отдельно.'
                    : 'Настройки сохранены на выбранном компьютере. Успешный запрос к модели проверяется отдельно.'}
                action={kind === 'openai-compatible' && props.onConfigured && <Button onClick={props.onConfigured}>Вернуться к агентам</Button>} />}
            <details><summary>Подробности</summary><Space direction="vertical" size={12} className="provider-setup__content">
                {kind === 'openai-compatible' ? <Typography.Paragraph type="secondary">Карточка и серверное API общие. Здесь настраивается отдельный локальный провайдер OpenCode: ключ с сервера не переносится.</Typography.Paragraph>
                    : <Typography.Paragraph type="secondary">API-ключ для Codex не требуется; локальный мастер предложит текущий вход или официальный экран. Серверный чат и делегированные команды Codex работают отдельно.</Typography.Paragraph>}
                {kind === 'openai-compatible' && <Typography.Paragraph type="secondary">Агент должен использовать выбранную каталожную модель с актуальными параметрами. Его применение проверяется отдельно: вернитесь к агентам и явно нажмите «Применить настройки» для текущей версии проекта.</Typography.Paragraph>}
                <Typography.Paragraph type="secondary">Мост запишет только управляемого провайдера в выбранной папке OpenCode. Чужие настройки сохранятся. Авторизация и ключи хранятся на компьютере; площадка получает только состояние готовности. После изменений перезапустите OpenCode.</Typography.Paragraph>
                <Button disabled={operation.busy} onClick={operation.reload}>Перечитать очередь</Button>
                {kind === 'openai-compatible' && <Button onClick={props.onReloadModels}>Обновить модели</Button>}
                {kind === 'codex-bridge' && props.canPrepareConnector && <>
                    <Typography.Text type="secondary">{supply.supply?.state === 'ready' ? 'Поставка коннектора подготовлена на сервере. Локальная настройка выполняется отдельно.' : supply.supply?.state === 'building' ? 'Сервер готовит закреплённый коннектор. Можно закрыть окно и вернуться позже.' : supply.supply?.state === 'conflict' ? 'Проверьте поставки и сборки в операциях; новая сборка не отправлена.' : 'Подготавливаем только закреплённый источник коннектора.'}</Typography.Text>
                    {!buildFlag.enabled && <Typography.Text type="warning">{buildFlag.reason}</Typography.Text>}
                    <Button disabled={supply.busy} onClick={() => {void supply.reload();}}>Обновить поставку Codex</Button>
                </>}
            </Space></details>
        </Space>
    </Modal>;
}
