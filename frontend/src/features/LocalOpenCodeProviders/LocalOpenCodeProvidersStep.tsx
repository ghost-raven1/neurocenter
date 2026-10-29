import {Alert,Button,Empty,List,Space,Spin,Tag,Typography} from 'antd';
import {OPENCODE_GLOBAL_PROVIDERS_READ_JOB as READ,OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB as OPEN,OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION} from '@neurocenter/opencode-local-providers';
import type {useBridge} from '../McpBridge/useBridge';
import {useLocalProviders} from './useLocalProviders';
import {terminal} from './model';
import {providerAuthenticationLabel} from './presentation';
import './LocalOpenCodeProviders.less';

/** Stage three uses the selected bridge before a folder exists; secret inputs are offered only by its private local window. */
export function LocalOpenCodeProvidersStep({bridge,enabled,onContinue,cliVersion}:{bridge:ReturnType<typeof useBridge>;enabled:boolean;onContinue:()=>void;cliVersion?:string}):JSX.Element{
    const compatible=cliVersion===OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION,legacy=cliVersion!==undefined&&!compatible;
    const {state,controller,canRead,canInspect,canOpen,blocker,openingBlocker}=useLocalProviders(bridge,enabled,compatible),inventory=state?.inventory;
    const known=compatible&&canRead&&!state?.storageError&&!state?.denied&&!!inventory&&!inventory.issues.length&&inventory.providers.some(row=>row.enabled&&(row.hasConfiguration||row.hasAuthentication));
    const canContinue=known||legacy&&canRead&&!state?.denied;
    return <section className="local-opencode-providers" aria-label="Локальные провайдеры OpenCode"><Typography.Title level={4}>{legacy?'Файлы прежнего формата':'Провайдеры OpenCode'}</Typography.Title>
        <Typography.Paragraph>Используйте провайдеров на выбранном компьютере или добавьте их в локальном окне. Этот мастер не отправляет ключи на сервер.</Typography.Paragraph>
        {blocker&&<Alert type="info" showIcon message={blocker}/>}
        {legacy&&<Alert type="info" showIcon message="Для этой версии доступно только чтение прежних файлов. Настройте провайдеров в OpenCode."/>}
        {cliVersion===undefined&&<Alert type="info" showIcon message="Версия обычной команды OpenCode не подтверждена" description="Проверьте её на предыдущем шаге. Чтение сохранённых файлов и квитанций доступно."/>}
        {compatible&&openingBlocker&&<Alert type="info" showIcon message={openingBlocker}/>}
        {state?.error&&<Alert type="warning" showIcon message={state.error} action={<Button onClick={()=>void controller.refresh()} loading={state.busy}>Проверить квитанцию</Button>}/>}
        {state?.storageError&&<Alert type="warning" showIcon message={state.storageError} action={<Button onClick={()=>void controller.refresh()}>Перечитать журнал</Button>}/>}
        {!state?<Spin/>:inventory?<List size="small" dataSource={inventory.providers} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Локальные провайдеры пока не настроены."/>}}
            renderItem={row=><List.Item><Space direction="vertical" size={0}><Space wrap><Typography.Text className="local-opencode-providers__identity" strong>{row.id}</Typography.Text><Tag>{providerAuthenticationLabel(row.authentication,legacy)}</Tag>{!row.enabled&&<Tag>Выключен в конфигурации</Tag>}</Space>
                <Typography.Text className="local-opencode-providers__models" type="secondary">{row.modelIds.length?'Модели из конфигурации: '+row.modelIds.join(', '):'Модели в глобальной конфигурации не перечислены.'}</Typography.Text></Space></List.Item>}/>:<Typography.Paragraph type="secondary">Перечитайте состояние выбранного компьютера. После локального сохранения проверьте его ещё раз.</Typography.Paragraph>}
        {!!inventory?.issues.length&&<Alert type="warning" showIcon message="Состояние прочитано частично" description="Проверьте локальные файлы, переопределения окружения и ограничения. Исходные данные сохранены; переход ждёт полного чтения."/>}
        {state?.jobs[OPEN]?.result?.status==='opened'&&<Alert type="info" showIcon message="Локальное окно открыто" description="Сохранение проверяется отдельно: завершите настройку на компьютере и перечитайте состояние."/>}
        {state?.jobs[OPEN]?.result?.status==='failed'&&state.jobs[OPEN]?.result?.issue==='unsupported-version'&&<Alert type="info" showIcon message="Локальная запись требует OpenCode1.14.48" description="Обычная команда OpenCode не подтверждена как совместимая. Настройки сохранены; чтение доступно. Проверьте версию на предыдущем шаге."/>}
        <Space wrap><Button loading={state?.busy} disabled={!canInspect||!!state?.storageError} onClick={()=>void controller.start(READ)}>Перечитать провайдеров</Button>
            <Button disabled={!compatible||!canOpen||state?.busy||!!state?.storageError} onClick={()=>void controller.start(OPEN)}>Настроить на компьютере</Button>
            <Button type="primary" disabled={!canContinue||state?.busy} onClick={()=>{if(canContinue)onContinue();}}>{legacy?'Продолжить с настройкой OpenCode':'Использовать текущую настройку'}</Button></Space>
        <details><summary>История и восстановление</summary><Button disabled={state?.busy} onClick={()=>void controller.refresh()}>Обновить историю</Button></details>
        {state?.replayKinds.map(kind=><Button key={kind} disabled={state.busy||(kind===OPEN?!canOpen:!canRead)} onClick={()=>void controller.replay(kind)}>Повторить тот же запрос: {kind===OPEN?'открытие окна':'чтение'}</Button>)}
        {([READ,OPEN] as const).map(kind=>state?.jobs[kind]&&!terminal(state.jobs[kind])&&<Button key={kind} danger disabled={state.busy||!canRead} onClick={()=>void controller.cancel(kind)}>Отменить {kind===OPEN?'открытие':'чтение'}</Button>)}
        <Typography.Paragraph type="secondary">{legacy?'Прежние файлы не подтверждают эффективную настройку текущей версии OpenCode.':'Это подтверждает сохранённую настройку.'} Модель автоматически не выбирается, запрос модели не выполняется.</Typography.Paragraph>
    </section>;
}
