import {Alert,Button,List,Space,Tag,Typography} from 'antd';
import type {IBridgeJob} from '../McpBridge/api';
import {methodLabels,workflowAgentIdentity,workflowNextAction,workflowResult} from './model';
import {workflowAgentLabel,type WorkflowAgentCatalog} from './agentSelection';

/** Show actual execution and check evidence separately from the queue's delivery state. */
export function WorkflowResult({job,onSetupRuntime,agentCatalog}:{job:IBridgeJob;onSetupRuntime?:()=>void;agentCatalog?:WorkflowAgentCatalog|null}):JSX.Element{
    const agent=workflowAgentIdentity(job.agent),result=workflowResult(job.result,agent);
    const identity=<Typography.Text strong>{agent?`Исполнитель: ${workflowAgentLabel(agent,agentCatalog)}`:job.agent?'Идентичность выбранного агента не подтверждена':'Прежний запуск без выбранного агента'}</Typography.Text>;
    if(!result)return <Space direction="vertical" className="agent-methods__result">{identity}<Alert type={job.state==='failed'||job.state==='succeeded'?'warning':'info'} showIcon message={job.state==='succeeded'?'Результат исполнения не подтверждён':job.message||'Ожидаем результат локального исполнителя.'}/></Space>;
    const success=job.state==='succeeded'&&result.state==='succeeded';
    const stages={prerequisites:'Подготовка',execution:'Выполнение',checks:'Проверки',completed:'Завершено'};
    return <Space direction="vertical" className="agent-methods__result">
        {identity}
        <Alert showIcon type={success?'success':'warning'} message={success?'Задание выполнено':'Задание требует продолжения'} description={<>
            {methodLabels[result.method]} {result.methodVersion} · {stages[result.stage]}{result.failure&&<> · {result.failure.code}</>}
            <br/>{workflowNextAction(result)}</>}/>
        {(result.failure?.action==='setup-method'||result.failure?.action==='setup-agent'||result.failure?.code==='QUIRK_STORAGE_INVALID')&&<Button href="/help/agent-method-workflows" target="_blank" rel="noopener noreferrer">Как подготовить методику</Button>}
        {result.failure?.action==='setup-runtime'&&onSetupRuntime&&<Button onClick={onSetupRuntime}>Настроить OpenCode</Button>}
        <Typography.Text>{result.changes.length?`Наблюдаемые изменения файлов: ${result.changes.length}`:'Изменения файлов не подтверждены'}</Typography.Text>
        {!!result.checks.length&&<List size="small" header="Фактические проверки" dataSource={result.checks} renderItem={check=><List.Item>
            <Typography.Text code>{[check.command,...check.args].join(' ')}</Typography.Text>
            <Tag color={check.state==='passed'?'green':check.state==='failed'?'red':undefined}>{check.state==='passed'?'Успешно':check.state==='failed'?'Ошибка':'Не запускалась'}{check.exitCode!==null?' · '+check.exitCode:''}</Tag>
        </List.Item>}/>}
        {!!result.changes.length&&<List size="small" header="Изменённые файлы" dataSource={result.changes} renderItem={file=><List.Item><Typography.Text code>{file.path}</Typography.Text></List.Item>}/>}
        {!!result.artifacts.length&&<List size="small" header="Артефакты методики в локальной папке" dataSource={result.artifacts} renderItem={file=><List.Item><Typography.Text code>{file.path}</Typography.Text></List.Item>}/>}
    </Space>;
}
