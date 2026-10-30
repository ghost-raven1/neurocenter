import {Alert,Button,Space,Typography} from 'antd';
import {useComputerEnvironment} from '../../features/ComputerSetup/ComputerEnvironment';
import {cliTerminal} from '../../features/ComputerSetup/model';
import {cliObservationPresentation} from '../../features/ComputerSetup/presentation';
const failures={
    'source-changed':'Комплект OpenCode изменился. Обновите мост перед новой установкой.',
    'source-unavailable':'Проверенный комплект OpenCode недоступен. Обновите мост.',
    'existing-cli-unavailable':'Существующий OpenCode не запускается. Проверьте его на компьютере; ручной файл сохранён.',
    'destination-unsafe':'Проверьте каталог ~/.local/bin на компьютере. Ссылки и небезопасные каталоги установщик не заменяет.',
    'destination-changed':'Команда или каталог изменились во время установки. Проверьте OpenCode перед повтором.',
    'install-busy':'Другой установщик занят. Дождитесь его завершения и проверьте OpenCode.',
    'verification-failed':'Версия OpenCode не подтверждена. Проверьте текущее состояние перед повтором.',
    'cancelled':'Установка отменена. Проверьте текущее состояние перед повтором.',
    'authorization-lost':'Доступ к компьютеру изменился. Подтвердите действующую роль и подключение.',
    'interrupted':'Установка прервалась. Проверьте сохранённое состояние перед повтором.',
    'install-failed':'Установка не завершена. Проверьте компьютер и текущее состояние OpenCode.',
};

/** An explicit fixed bridge job installs the verified bundled CLI, preserving local credentials and configuration. */
export function OpenCodeSetupStep({enabled,onBridge,onContinue}:{enabled:boolean;onBridge:()=>void;onContinue:()=>void}):JSX.Element {
    const {cli,installation}=useComputerEnvironment(),state=installation.state,job=state.job,result=job?.installation;
    const view=cliObservationPresentation(cli.state),pending=!!job&&!cliTerminal(job),unconfirmed=!!state.intent&&!job;
    const reconciled=cli.state.job?.kind==='inspect-opencode-cli'&&!!view.observation&&['installed','missing'].includes(view.observation.status)&&!!job&&Date.parse(cli.state.job.createdAt)>Date.parse(job.updatedAt);
    const installed=view.observation?.status==='installed',unknown=result?.status==='unknown'&&!reconciled;
    const notice=state.storageError||state.error;
    return <Space direction="vertical" size={16} style={{width:'100%'}}>
        <Typography.Title level={3}>OpenCode через мост</Typography.Title>
        <Typography.Paragraph>{installed?'OpenCode найден на выбранном компьютере. Настройки и ключи локальных провайдеров сохраняются.':'Мост установит OpenCode из своего проверенного комплекта. Дополнительная загрузка и системные Node.js или npm не нужны.'}</Typography.Paragraph>
        {(pending||unconfirmed)&&<Alert type="info" showIcon message={unconfirmed?'Проверяем принятие установки':job?.state==='queued'?'Установка в очереди':job?.state==='reconciling'?'Подтверждаем результат установки':'Мост устанавливает OpenCode'}
            description="Страница может быть закрыта: принятый запрос и его результат сохраняются."/>}
        {notice&&<Alert type="warning" showIcon message={notice} action={<Button onClick={onBridge}>Настройка моста</Button>}/>}
        {result?.status==='failed'&&result.failure&&<Alert type="warning" showIcon message={failures[result.failure]}/>}
        {unknown&&<Alert type="warning" showIcon message="Исход установки требует сверки" description="Проверьте OpenCode на компьютере. Повторная запись файлов автоматически не выполняется."/>}
        {result?.nextAction==='inspect-path'&&<Alert type="warning" showIcon message="CLI сохранён, команда в PATH пока не подтверждена"
            description="Убедитесь, что ~/.local/bin доступен в PATH рабочего терминала, затем откройте новый терминал и проверьте OpenCode. Мост сохраняет ручные настройки оболочки."/>}
        {!pending&&!unconfirmed&&(installed?<Button type="primary" disabled={!enabled} onClick={onContinue}>К провайдерам</Button>
            :unknown||view.observation?.status!=='missing'?<Button type="primary" disabled={!cli.canStart||cli.state.busy||view.running} loading={cli.state.busy||view.running} onClick={()=>{void cli.controller.start();}}>Проверить OpenCode</Button>
                :<Button type="primary" disabled={!enabled||!installation.canStart||state.busy||state.denied} loading={state.busy} onClick={()=>{void installation.controller.start();}}>Установить OpenCode через мост</Button>)}
        {(pending||unconfirmed)&&<Space>
            <Button loading={state.busy} onClick={()=>{void installation.controller.check();}}>Проверить установку</Button>
            {pending&&<Button disabled={!installation.canCancel||state.busy||state.denied} onClick={()=>{void installation.controller.cancel();}}>Отменить установку</Button>}
        </Space>}
        {state.canReplay&&<Button disabled={!installation.canStart||state.busy||installation.roleChanged} onClick={()=>{void installation.controller.replay();}}>Повторить сохранённый запрос</Button>}
        {!installed&&!pending&&installation.blocker&&<Alert type="info" showIcon message={installation.blocker} action={<Button onClick={onBridge}>К подключению моста</Button>}/>}
        {job&&<details><summary>Последняя установка</summary><Typography.Text type="secondary">{job.id} · {new Date(job.updatedAt).toLocaleString('ru-RU')}</Typography.Text></details>}
    </Space>;
}
