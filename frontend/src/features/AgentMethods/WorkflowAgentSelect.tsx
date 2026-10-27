import {Alert,Button,Select,Typography} from 'antd';
import {workflowAgentIssue,type WorkflowAgentCatalog} from './agentSelection';

interface Props {
    catalog:WorkflowAgentCatalog|null;loading:boolean;error:string;enabled:boolean;reason:string;selected?:string;disabled:boolean;
    onChange:(agentId:string|undefined)=>void;onReload:()=>Promise<unknown>;
}

/** A saved missing or disabled selection remains explicit until the person clears or replaces it. */
export function WorkflowAgentSelect({catalog,loading,error,enabled,reason,selected,disabled,onChange,onReload}:Props):JSX.Element{
    const heads=new Map(catalog?.items.map(item=>[item.id,item])??[]);
    const choices=(catalog?.assignments??[]).filter(item=>item.enabled&&!item.removed&&!item.card.archivedAt&&heads.has(item.agentId)&&!heads.get(item.agentId)!.archivedAt);
    const options=choices.map(item=>({value:item.agentId,label:`${item.card.name} · ${item.card.slug} · v${item.version}${workflowAgentIssue(item,catalog)?' · не готов':''}`,
        disabled:!enabled||loading||!!error||!!workflowAgentIssue(item,catalog)}));
    if(selected&&!options.some(item=>item.value===selected))options.push({value:selected,label:'Прежний выбор недоступен — выберите агента',disabled:true});
    return <>
        <label>Агент проекта<Select aria-label="Агент для задачи методики" value={selected} loading={loading} disabled={disabled} allowClear
            placeholder={enabled?'Выберите агента проекта':'Без проектного агента · прежний режим'} options={options} onChange={onChange}/></label>
        {!enabled&&<Alert type="info" showIcon message={reason} description={selected?'Выбор сохранён. Для прежнего режима явно очистите агента; автоматической замены нет.':'Прежний режим использует модель папки. История и отмена выбранных агентов доступны.'}/>}
        {(loading||error||enabled&&!choices.length)&&<Alert type={error?'warning':'info'} showIcon
            message={loading?'Проверяем агентов проекта':error||'В проекте нет включённых агентов. Добавьте или включите основного агента с явной моделью.'}
            action={<Button disabled={loading} onClick={()=>{void onReload();}}>Обновить агентов</Button>}/>}
        {enabled&&<Typography.Text type="secondary">Выбранный агент ведёт полный цикл. Перед запуском примените текущие настройки агентов к этой папке OpenCode.</Typography.Text>}
    </>;
}
