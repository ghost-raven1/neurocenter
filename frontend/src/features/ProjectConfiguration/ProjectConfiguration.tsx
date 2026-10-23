import {Alert,Button,Space,Tooltip,Typography} from 'antd';
import {useEffect,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectRoleLevel} from '../UserBlock/roles';
import type {useBridge} from '../McpBridge/useBridge';
import {bridgeApi,type IBridgeJob} from '../McpBridge/api';
import {configurationTarget,PROJECT_CONFIGURATION_JOB} from './model';
import './ProjectConfiguration.less';
/** The website opens a local wizard; configuration contents and diffs never enter website state. */
export function ProjectConfiguration({projectId,bridge}:{projectId:string;bridge:ReturnType<typeof useBridge>}):JSX.Element{
    const user=useSelector((state:RootState)=>state.userBlock.user),admin=projectRoleLevel(user,projectId)>=3;
    const {scope,captureOwner}=useAuthRequestOwner(),availability=configurationTarget(bridge,projectId,admin);
    const context=JSON.stringify([scope,projectId,availability.target]),currentContext=useRef(context);currentContext.current=context;
    const requestKey=useRef<{context:string;key:string}>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[accepted,setAccepted]=useState<IBridgeJob>();
    useEffect(()=>{setBusy(false);setError('');setAccepted(undefined);requestKey.current=undefined;},[context]);
    const jobs=bridge.jobs.filter(job=>job.kind===PROJECT_CONFIGURATION_JOB&&job.projectId===projectId&&job.deviceId===bridge.device?.id);
    const history=[...jobs,...accepted&&!jobs.some(job=>job.id===accepted.id)?[accepted]:[]].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5);
    const pending=history.find(job=>['queued','running','reconciling'].includes(job.state));
    const open=async()=>{
        if(!availability.target||busy||pending)return;const owner=captureOwner(),identity=context;
        if(!requestKey.current||requestKey.current.context!==identity)requestKey.current={context:identity,key:crypto.randomUUID()};
        setBusy(true);setError('');try{const job=await bridgeApi.create({...availability.target,kind:PROJECT_CONFIGURATION_JOB,requestKey:requestKey.current.key});
            if(owner()&&currentContext.current===identity){setAccepted(job);requestKey.current=undefined;void bridge.reload();}
        }catch{if(owner()&&currentContext.current===identity)setError('Открытие не подтверждено. Повтор использует тот же запрос; также можно перечитать задания.');}
        finally{if(owner()&&currentContext.current===identity)setBusy(false);}
    };
    const cancel=async(job:IBridgeJob)=>{if(!admin||busy||job.state!=='queued')return;const owner=captureOwner(),identity=context;setBusy(true);try{await bridgeApi.cancel(job.id);if(owner()&&currentContext.current===identity){setAccepted(undefined);setError('');await bridge.reload();}}catch{if(owner()&&currentContext.current===identity)setError('Отмена не подтверждена. Перечитайте задания компьютера.');}finally{if(owner()&&currentContext.current===identity)setBusy(false);}};
    return <section className="project-configuration" aria-label="Локальные файлы OpenCode"><div className="project-configuration__entry"><div><Typography.Text strong>Файлы проекта</Typography.Text><Typography.Paragraph type="secondary">AGENTS.md, настройки OpenCode и установленного RAG. Изменения и секреты остаются на компьютере.</Typography.Paragraph></div>
        <Tooltip title={availability.reason}><span><FeatureButton features={['project_configuration','computer_connections']} disabled={!availability.target||!!pending} loading={busy} onClick={()=>{void open();}}>Открыть локальный редактор</FeatureButton></span></Tooltip></div>
        {error&&<Alert type="warning" showIcon message={error} action={<Button size="small" onClick={()=>{void bridge.reload();}}>Перечитать задания</Button>}/>}
        {!!history.length&&<details className="project-configuration__history"><summary>Открытия редактора · {history.length}</summary><ul>{history.map(job=><li key={job.id}><Space wrap><Typography.Text>{job.state==='succeeded'?'Мастер открыт на компьютере; применение файлов подтверждается только в нём.':job.message||'Ожидает открытия локального мастера.'}</Typography.Text>
            <Typography.Text type="secondary">{new Date(job.createdAt).toLocaleString('ru-RU')}</Typography.Text>{job.state==='queued'&&<Button size="small" disabled={!admin||busy} onClick={()=>{void cancel(job);}}>Отменить открытие</Button>}</Space></li>)}</ul><Typography.Text type="secondary">После открытия мастер действует до 15 минут. Закрытие и локальная копия для восстановления доступны в его вкладке.</Typography.Text></details>}
    </section>;
}
