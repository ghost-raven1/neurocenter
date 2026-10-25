import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Empty,Form,Modal,Select,Space,Tag,Typography} from 'antd';
import {useBridge} from '../McpBridge/useBridge';
import type {IBridgeJob} from '../McpBridge/api';
import {useLearningQuirksImport} from './useLearningQuirksImport';
import type {LearningQuirksInstallation,LearningQuirksJobInput,QuirksReceipt} from './quirksImportTypes';
import './LearningQuirksImport.less';

interface Props {open:boolean;projectId:string;canManage:boolean;enabled?:boolean;disabledReason?:string;onClose:()=>void;onImported?:()=>void}
const installationKey=(item:LearningQuirksInstallation)=>JSON.stringify([item.deviceId,item.assetKind,item.assetId,item.manifest]);
const stateLabels:Record<string,string>={queued:'Ожидает компьютер',running:'Сбор выполняется',succeeded:'Сбор завершён',failed:'Сбор остановлен',cancelled:'Отменено',reconciling:'Проверяем завершение'};
const activeJob=(job:IBridgeJob)=>['queued','running','reconciling'].includes(job.state);
function receipt(job:IBridgeJob):QuirksReceipt|undefined{
    const result=job.result as unknown as QuirksReceipt|undefined;
    return result?.schemaVersion===1&&['complete','partial'].includes(result.status)&&Number.isSafeInteger(result.imported)&&Number.isSafeInteger(result.skipped)?result:undefined;
}
/** The user chooses named devices/installations; technical source paths never become editable import authority. */
export function LearningQuirksImportModal({open,projectId,canManage,enabled=true,disabledReason,onClose,onImported}:Props):JSX.Element{
    const bridge=useBridge(open),action=useLearningQuirksImport(projectId,bridge.reload,canManage,enabled);
    const [computer,setComputer]=useState(''),[installation,setInstallation]=useState('');
    const notified=useRef(new Set<string>());
    useEffect(()=>{setComputer('');setInstallation('');notified.current.clear();},[projectId]);
    useEffect(()=>{const input=action.intent;if(input){setComputer(input.deviceId);setInstallation(JSON.stringify([input.deviceId,input.assetKind,input.assetId,input.expectedManifest]));}},[action.intent]);
    const device=bridge.devices.find(item=>item.id===computer)??(!action.intent&&bridge.devices.length===1?bridge.devices[0]:undefined);
    // Keep recognized older installations visible so their upgrade requirement can be explained.
    const options=(bridge.installations as LearningQuirksInstallation[]).filter(item=>item.projectId===projectId&&item.deviceId===device?.id
        &&(item.learningQuirks?.supported||item.hostedEmbedding?.supported||item.ragUi?.supported));
    const selected=options.find(item=>installationKey(item)===installation)??(!action.intent&&options.length===1?options[0]:undefined);
    const computerOptions=bridge.devices.map(item=>({value:item.id,label:item.name+(item.online?'':' · не подключён')}));
    const installationOptions=options.map(item=>({value:installationKey(item),label:item.name+' · версия '+item.version+(item.folderName?' · '+item.folderName:'')}));
    const original=action.intent,originalInstallation=original?JSON.stringify([original.deviceId,original.assetKind,original.assetId,original.expectedManifest]):undefined;
    if(original&&!computerOptions.some(item=>item.value===original.deviceId))computerOptions.push({value:original.deviceId,label:'Исходный компьютер'});
    if(original&&originalInstallation&&!installationOptions.some(item=>item.value===originalInstallation))installationOptions.push({value:originalInstallation,label:'Исходная установка OpenCodeRAG · версия '+original.version});
    const binding=device?.report.bindings?.find(item=>item.projectId===projectId);
    const submitted=action.submitted?.projectId===projectId?action.submitted:undefined;
    const jobs=bridge.jobs.filter(job=>job.kind==='import-learning-quirks'&&job.projectId===projectId&&job.id!==submitted?.id);
    if(submitted)jobs.unshift(submitted);
    useEffect(()=>{
        for(const job of jobs){if(!activeJob(job)&&receipt(job)&&!notified.current.has(job.id)){notified.current.add(job.id);onImported?.();}}
    },[jobs,onImported]);
    let blocker='';
    if(!enabled)blocker=disabledReason?disabledReason+'. История и остановка остаются доступны.':'Сбор кварков выключен в настройках функций. История и остановка остаются доступны.';
    else if(!canManage)blocker='Сообщать опыт может разработчик проекта.';
    else if(!bridge.devicesReady||!bridge.installationsReady)blocker=bridge.error||'Загружаем компьютеры и установки.';
    else if(!device)blocker='Выберите компьютер с установленным OpenCodeRAG.';
    else if(!device.online)blocker='Компьютер не подключён. Запустите MCP-мост и обновите состояние.';
    else if(!device.report.capabilities?.includes('project-learning-quirks-v1'))blocker='Обновите MCP-мост для безопасного сбора кварков.';
    else if(!selected)blocker='Установите OpenCodeRAG в проект или выберите его управляемую установку.';
    else if(!selected.learningQuirks?.supported)blocker='Обновите OpenCodeRAG из каталога: эта установка ещё не подтверждает формат кварков.';
    else if(!selected.isCurrentBinding||!binding?.instanceId||binding.bindingId!==selected.bindingId)blocker='Подтвердите текущую папку проекта и обновите список установок.';
    else if(selected.configurationSchemaDigest&&!selected.configuration?.ready)blocker='Задайте параметры RAG на компьютере и обновите статус настройки в установках.';
    else if(jobs.some(job=>activeJob(job)&&job.deviceId===device.id))blocker='Сбор на этом компьютере уже выполняется. Дождитесь результата или остановите его.';
    const submit=()=>{
        if(blocker||action.intent||action.loading||action.blocked||!selected||!binding?.instanceId||!selected.bindingId||!device||!['mcp','plugin'].includes(selected.assetKind))return;
        const input:LearningQuirksJobInput={kind:'import-learning-quirks',deviceId:device.id,projectId,assetId:selected.assetId,assetKind:selected.assetKind as 'mcp'|'plugin',version:selected.version,
            expectedManifest:selected.manifest,expectedBindingId:selected.bindingId,expectedInstanceId:binding.instanceId,
            expectedConfigurationRevisions:selected.configurationSchemaDigest?[{assetId:selected.assetId,manifest:selected.manifest,revision:selected.configuration?.revision??null}]:[]};
        void action.submit(input);
    };
    return <Modal open={open} title="Собрать кварки RAG" onCancel={onClose} footer={<Space wrap><Button onClick={onClose}>Закрыть</Button><Button type="primary" disabled={!!blocker||!!action.intent||action.loading||action.blocked} loading={action.busy} onClick={submit}>Собрать кварки</Button></Space>} width={680}>
        <div className="learning-quirks-import">
            <Alert type="info" showIcon message="Кварки станут сообщённым опытом" description="Кварки — наблюдения из RAG выбранного проекта. Они требуют проверки человеком перед применением. Повторный сбор одинаковых записей безопасен; исходная база RAG сохраняется." />
            <Form layout="vertical"><Form.Item label="Компьютер"><Select aria-label="Компьютер для сбора кварков" value={original?.deviceId??device?.id} disabled={!!action.intent||action.loading} placeholder="Выберите компьютер" loading={bridge.loading}
                options={computerOptions} onChange={value=>{setComputer(value);setInstallation('');}} /></Form.Item>
                <Form.Item label="Установка OpenCodeRAG"><Select aria-label="Установка OpenCodeRAG" value={originalInstallation??(selected?installationKey(selected):undefined)} disabled={!!action.intent||action.loading} placeholder="Выберите установку"
                    options={installationOptions} onChange={setInstallation} /></Form.Item></Form>
            {blocker&&<Alert role="status" type="warning" showIcon message={blocker} />}
            {action.error&&<Alert role="alert" type="error" showIcon message={action.error} description={action.intent?'Исходный запрос и выбор сохранены. Проверка не запускает новый сбор.':'Выбор сохранён. Устраните причину и обновите состояние перед новой отправкой.'} />}
            {action.intent&&<Alert role="status" type="warning" showIcon message="Исходный запрос сохранён" description={action.roleChanged?'Для повторной отправки вернитесь к роли исходной отправки. Проверка и история доступны.':'Пока результат не подтверждён, новый сбор недоступен. Исходная установка: '+action.intent.assetId+' · версия '+action.intent.version+'.'}
                action={<Space wrap><Button loading={action.busy} onClick={()=>{void action.check();}}>Проверить отправку</Button>
                    {action.missing&&<Button disabled={!canManage||!enabled||action.busy||action.blocked||action.roleChanged} onClick={()=>{void action.repeat();}}>Отправить исходный запрос</Button>}</Space>}/>}
            <Space><Typography.Title level={5}>История сборов</Typography.Title><Button size="small" loading={bridge.loading} onClick={()=>{void bridge.reload();void action.check();}}>Обновить</Button></Space>
            {bridge.errors.jobs&&<Alert type="error" role="alert" message={bridge.errors.jobs} />}
            {!jobs.length&&!bridge.loading?<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Кварки ещё не собирали" />:jobs.slice(0,10).map(job=>{
                const result=receipt(job),partial=result?.status==='partial',confirmed=!!result&&(result.imported+result.skipped)>0;
                return <div className="learning-quirks-import__job" key={job.id}><Space wrap><Tag color={partial?'warning':job.state==='succeeded'?'success':'default'}>{partial?confirmed?'Сохранена часть опыта':'Завершение не подтверждено':stateLabels[job.state]??job.state}</Tag>
                    <Typography.Text>{bridge.devices.find(item=>item.id===job.deviceId)?.name??'Компьютер'}</Typography.Text>
                    {canManage&&activeJob(job)&&<Button size="small" disabled={action.busy} onClick={()=>{void action.cancel(job.id);}}>Остановить</Button>}</Space>
                    <Typography.Paragraph>{partial?confirmed?'Сохранённый опыт остаётся. Обновите состояние и повторите сбор — дубликаты не появятся.':'Результат записи не подтверждён. Повтор безопасен: уже принятые записи не будут добавлены снова.':job.message}</Typography.Paragraph>
                    {result&&<Typography.Text type="secondary">Добавлено: {result.imported}; уже собрано: {result.skipped}; осталось: {result.remaining}.</Typography.Text>}
                </div>;
            })}
        </div>
    </Modal>;
}
