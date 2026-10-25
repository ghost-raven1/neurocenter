import { FeatureButton, useFeatureAvailability } from '../FeatureFlags/FeatureAvailability';
import { Alert, Button, List, Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import baseApi from '../../core/api/base';
import { errorMessage } from '../../common/utils/errorMessage';
import { bridgeApi, type IBridgeJob } from '../McpBridge/api';
import { useBridge } from '../McpBridge/useBridge';
import { createBridgeRequestKey } from '../McpBridge/bridgeRequestKey';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import type { ICatalogModel, IDeviceCodexConnection, IRemoteConnectionHint, IRemoteModelOptions } from './types';

interface Candidate {candidateId:string;provider:string;name:string;model:string;capability:'vision'|'chat';runtime:string|null;hasKey:boolean;blocker:string|null;outputTokenLimit?:number;options?:IRemoteModelOptions;parameterIssues?:Array<{name:string;type:string}>;timeoutMs?:number}
interface Scan {schemaVersion:2;scope:'global'|'project';deviceId?:string;projectId?:string;bindingId?:string;instanceId?:string;candidates:Candidate[];warnings:string[];expiresAt:string}
interface IProps {projectId?:string;onClose:()=>void;onImported:(model:ICatalogModel,hint?:IRemoteConnectionHint)=>Promise<void>;onConfigureCodex?:(deviceId:string)=>void}
const localCodexCandidate = (candidate: Candidate): boolean => candidate.blocker === 'codex-local-auth'
    || candidate.provider === 'codexbridge' && candidate.blocker === 'unsupported-provider';
const blocker:Record<string,string>={'unsupported-provider':'Провайдер или параметры не поддерживаются; настройте подключение вручную','missing-endpoint':'Адрес API не задан','unresolved-endpoint':'Адрес задан через переменную или файл','unsafe-endpoint':'Адрес API не подходит для импорта','disabled-provider':'Провайдер отключён в OpenCode'};
Object.assign(blocker,{'codex-local-auth':'CodexBridge использует локальный вход и специальный транспорт Responses. В настройке провайдера проекта выберите «Codex Bridge — локальный вход». Импорт в серверный API не переносит этот вход.',
    'local-provider-auth':'Авторизацией управляет локальный OpenCode. Для серверного API нужно отдельное поддерживаемое подключение; локальная сессия не переносится.',
    'device-local-endpoint':'Этот localhost относится к выбранному компьютеру. Запросы каталога выполняются сервером: задайте доступный серверу адрес API вручную.'});
const scanProblems:Record<string,string>={'invalid-json':'В конфигурации ошибка JSON/JSONC или повторяющийся ключ. Исправьте файл на компьютере и прочитайте его заново.',
    'read-failed':'Не удалось прочитать часть конфигурации. Проверьте права на файлы OpenCode.', 'unsafe-path':'Конфигурация использует символическую ссылку или небезопасный путь. Автоматическое чтение остановлено.',
    'ambiguous-config':'Обновите мост и повторите чтение: настройки opencode.jsonc накладываются поверх opencode.json.', 'source-changed':'Конфигурация изменилась во время чтения. Повторите проверку.'};

/** Чтение — отдельное действие: импорт выбранной записи никогда не переносит ключ с компьютера. */
export function OpenCodeImportModal({projectId,onClose,onImported,onConfigureCodex}:IProps):JSX.Element {
    const bridge=useBridge(),{captureOwner}=useAuthRequestOwner();
    const codexAvailability=useFeatureAvailability('codex_connector','device_codex_inference');
    const scanAvailability=useFeatureAvailability('opencode_model_sync','computer_connections');
    const [selected,setSelected]=useState(''),[submitted,setSubmitted]=useState<IBridgeJob>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const [scope,setScope]=useState<'global'|'project'>(projectId?'project':'global');
    const lock=useRef(false),request=useRef<{key:string;requestKey:string}>();
    const device=bridge.devices.find(item=>item.id===selected)||(bridge.devices.length===1?bridge.devices[0]:undefined);
    const binding=device?.report.bindings?.find(item=>item.projectId===projectId);
    const alive=useRef(true),currentContext=useRef('');
    const context=JSON.stringify([device?.id,scope,projectId,binding?.bindingId,binding?.instanceId,device?.online,
        bridge.devicesReady,device?.report.capabilities,scanAvailability.enabled,codexAvailability.enabled]);
    currentContext.current=context;
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
    const localCodexAvailable=!!device?.online&&!!device.report.capabilities?.includes('device-codex-inference-v1')&&codexAvailability.enabled;
    const job=bridge.jobs.find(item=>item.id===submitted?.id)||submitted;
    const active=!!job&&['queued','running','reconciling'].includes(job.state);
    const result=job?.state==='succeeded'&&job.deviceId===device?.id?job.result as unknown as Scan:undefined;
    const scan=result?.schemaVersion===2&&result.scope===scope&&Array.isArray(result.candidates)&&Array.isArray(result.warnings)
        &&typeof result.expiresAt==='string'&&Number.isFinite(Date.parse(result.expiresAt))
        &&(scope==='global'?result.deviceId===device?.id:result.projectId===projectId&&result.bindingId===binding?.bindingId&&result.instanceId===binding?.instanceId)?result:undefined;
    const scanExpired=!!scan&&Date.parse(scan.expiresAt)<=Date.now();
    const start=async():Promise<void>=>{
        const owns=captureOwner(),current=():boolean=>alive.current&&owns()&&currentContext.current===context;
        if(!current()||!scanAvailability.enabled||!bridge.devicesReady||lock.current||!device||!device.online||!device.report.capabilities?.includes('opencode-model-scan-v2')
            ||scope==='project'&&(!projectId||!binding?.bindingId||!binding.instanceId))return;
        lock.current=true;setBusy(true);setError('');
        const key=JSON.stringify([device.id,scope,scope==='project'?projectId:null,scope==='project'?binding?.bindingId:null]);if(request.current?.key!==key)request.current={key,requestKey:createBridgeRequestKey()};
        try{const result=await bridgeApi.create(scope==='global'
            ?{kind:'scan-opencode-models',scope,deviceId:device.id,requestKey:request.current.requestKey}
            :{kind:'scan-opencode-models',scope,deviceId:device.id,projectId:projectId!,expectedBindingId:binding!.bindingId!,requestKey:request.current.requestKey});
            if(!current())return;setSubmitted(result);request.current=undefined;void bridge.reload();
        }catch(cause){if(current())setError(errorMessage(cause,'Не удалось прочитать конфигурацию OpenCode.'));}
        finally{lock.current=false;if(alive.current&&owns())setBusy(false);}
    };
    const importCandidate=async(candidate:Candidate):Promise<void>=>{
        const owns=captureOwner(),current=():boolean=>alive.current&&owns()&&currentContext.current===context,localCodex=localCodexCandidate(candidate);
        if(!current()||!scanAvailability.enabled||lock.current||!device||!job||!scan||!bridge.devicesReady||candidate.blocker&&!(localCodex&&candidate.blocker==='codex-local-auth'&&localCodexAvailable))return;
        if(Date.parse(scan.expiresAt)<=Date.now()){setError('Снимок конфигурации устарел. Прочитайте OpenCode заново.');return;}
        lock.current=true;setBusy(true);setError('');
        try{const {data}=await baseApi.post<{model:ICatalogModel;baseUrl?:string;hasKeyOnComputer:boolean;options?:IRemoteModelOptions;timeoutMs?:number;localDeviceConnection?:IDeviceCodexConnection}>('/api/models/import-opencode',
            {deviceId:device.id,jobId:job.id,candidateId:candidate.candidateId,...(localCodex&&projectId?{projectId}:{})});
            if(!current())return;
            if(localCodex){
                if(data.model.runtime!=='device-codex'||data.localDeviceConnection?.deviceId!==device.id)throw new Error('Сервер не подтвердил подключение Codex к выбранному компьютеру.');
                await onImported(data.model);
            }else{
                if(typeof data.baseUrl!=='string'||data.model.runtime==='device-codex')throw new Error('Сервер не подтвердил API-подключение модели.');
                await onImported(data.model,{baseUrl:data.baseUrl,hasKey:data.hasKeyOnComputer,options:data.options,timeoutMs:data.timeoutMs});
            }
        }catch(cause){if(current())setError(errorMessage(cause,'Не удалось импортировать модель.'));}
        finally{lock.current=false;if(alive.current&&owns())setBusy(false);}
    };
    const available=!!device?.online&&device.report.capabilities?.includes('opencode-model-scan-v2')&&(scope==='global'||!!projectId&&!!binding?.bindingId&&!!binding.instanceId);
    return <Modal open centered className="model-details" title="Модели из OpenCode" width={680} onCancel={()=>{if(!lock.current)onClose();}} footer={<Button disabled={busy} onClick={onClose}>Закрыть</Button>}>
        <Typography.Paragraph type="secondary">Мост прочитает модели, адреса API и поддерживаемые параметры. Импорт выполняется по кнопке и не передаёт ключи с компьютера. Автосинхронизация и перенос ключей настраиваются отдельно в настройках компьютера.</Typography.Paragraph>
        {error&&<Alert showIcon type="error" message={error} className="model-catalog__notice"/>}
        {bridge.errors.devices&&<Alert showIcon type="error" message={bridge.errors.devices} action={<Button onClick={()=>{void bridge.reload();}}>Повторить</Button>} className="model-catalog__notice"/>}
        {bridge.devicesReady&&!bridge.errors.devices&&!bridge.devices.length&&<Alert showIcon type="info" message="Для импорта моделей подключите компьютер"
            action={<Button href="/start">Подключить компьютер</Button>} className="model-catalog__notice"/>}
        <Space direction="vertical" className="model-opencode__source">
            <Select aria-label="Источник конфигурации OpenCode" value={scope} disabled={busy||active} onChange={value=>{setScope(value);setSubmitted(undefined);setError('');request.current=undefined;}}
                options={[{value:'global',label:'Общая конфигурация компьютера'},{value:'project',label:'Итоговая конфигурация проекта',disabled:!projectId}]}/>
            <Typography.Text type="secondary">{scope==='global'?'Общие модели компьютера. Привязка папки проекта не нужна.':'Общие настройки OpenCode с учётом конфигурации выбранного проекта.'}</Typography.Text>
        <Space wrap><Select aria-label="Компьютер для импорта моделей" placeholder="Выберите компьютер" value={device?.id} disabled={busy||active} onChange={value=>{setSelected(value);setSubmitted(undefined);setError('');request.current=undefined;}}
            options={bridge.devices.map(item=>({value:item.id,label:item.name+(item.online?'':' · не на связи')}))}/>
            <FeatureButton features={['opencode_model_sync','computer_connections']} type="primary" loading={busy||active} disabled={!available||!bridge.devicesReady} onClick={()=>{void start();}}>Прочитать OpenCode</FeatureButton></Space></Space>
        {device&&!available&&<Typography.Paragraph type="secondary">{!device.online?'Компьютер не на связи.':!device.report.capabilities?.includes('opencode-model-scan-v2')?'Для чтения моделей обновите мост.':'Свяжите папку этого проекта с компьютером или выберите общую конфигурацию.'}</Typography.Paragraph>}
        {active&&<div role="status" aria-live="polite"><Spin size="small"/> {job?.message||'Читаем настройки OpenCode…'} <Button type="link" onClick={()=>{void bridge.reload();}}>Обновить</Button></div>}
        {job?.state==='failed'&&<Alert type="error" showIcon message={job.message}/>}
        {result&&!scan&&<Alert type="warning" showIcon message="Снимок не соответствует выбранному источнику. Прочитайте OpenCode заново."/>}
        {scanExpired&&<Alert type="warning" showIcon message="Снимок конфигурации устарел" description="Нажмите «Прочитать OpenCode», чтобы обновить список перед импортом." className="model-catalog__notice"/>}
        {scan&&<>
            {scan.candidates.some(localCodexCandidate)&&<Space direction="vertical" className="model-opencode__source">
                <Alert showIcon type="info" message="Codex через этот компьютер"
                    description={!device?.online?'Компьютер не на связи. Запустите мост и обновите список компьютеров.':!device.report.capabilities?.includes('device-codex-inference-v1')?'Обновите мост и заново прочитайте OpenCode, чтобы подключить Codex к Нейроцентру.':scan.candidates.some(candidate=>localCodexCandidate(candidate)&&candidate.blocker==='unsupported-provider')?'Снимок получен старым мостом. Нажмите «Прочитать OpenCode», чтобы подтвердить модели Codex.':!codexAvailability.enabled?codexAvailability.reason:'Подключите выбранную модель для чатов и агентов Нейроцентра. Вход Codex остаётся на компьютере. Модели в OpenCode сохраняются.'}/>
                {projectId?onConfigureCodex&&<Button type="link" disabled={busy} onClick={()=>{if(alive.current&&captureOwner()()&&currentContext.current===context&&!lock.current&&device)onConfigureCodex(device.id);}}>Настроить Codex в OpenCode</Button>
                    :<Typography.Text type="secondary">Откройте нужный проект → Модели → «Настроить в OpenCode» → «Codex Bridge — локальный вход» и выберите этот компьютер.</Typography.Text>}
            </Space>}
            {scan.warnings.some(warning=>scanProblems[warning])&&<Alert type="warning" showIcon message="Не удалось получить однозначный список моделей" description={scan.warnings.filter(warning=>scanProblems[warning]).map(warning=>scanProblems[warning]).join(' ')} className="model-catalog__notice"/>}
            {scan.warnings.length>0&&<Alert type="info" showIcon message="Прочитаны доступные настройки" description="Прочитайте предупреждения перед импортом. Неподдерживаемые или неоднозначные настройки не считаются готовым подключением." className="model-catalog__notice"/>}
            <List dataSource={scan.candidates} locale={{emptyText:'В доступной конфигурации нет моделей для импорта.'}} renderItem={candidate=>{
                // Older bridges classify the local Codex transport as a generic SDK mismatch.
                const localCodex=localCodexCandidate(candidate);
                return <List.Item className="model-opencode__candidate">
                <div><Typography.Text strong>{candidate.name}</Typography.Text><div><Typography.Text type="secondary">{candidate.provider} · {candidate.model}</Typography.Text></div><Tag>{candidate.capability==='vision'?'Изображения':'Чат'}</Tag>
                    {candidate.options&&Object.keys(candidate.options).length>0&&<div><Typography.Text type="secondary">{[
                        candidate.options.apiFormat?`API: ${candidate.options.apiFormat==='responses'?'Responses':'Chat Completions'}`:undefined,
                        candidate.options.reasoningEffort?`Рассуждения: ${candidate.options.reasoningEffort}`:undefined,
                        candidate.options.store!==undefined?`Хранение ответа: ${candidate.options.store?'включено':'выключено'}`:undefined,
                        candidate.options.temperature!=null?`Температура: ${candidate.options.temperature}`:undefined,
                        candidate.options.topP!=null?`Top P: ${candidate.options.topP}`:undefined,
                        candidate.options.maxOutputTokens!=null?`Ответ: до ${candidate.options.maxOutputTokens} токенов`:undefined,
                        candidate.options.contextWindow!=null?`Контекст: ${candidate.options.contextWindow} токенов`:undefined,
                    ].filter(Boolean).join(' · ')}</Typography.Text></div>}
                    {candidate.outputTokenLimit!=null&&<div><Typography.Text type="secondary">Предел ответа модели: {candidate.outputTokenLimit} токенов</Typography.Text></div>}
                    {candidate.timeoutMs!=null&&<div><Typography.Text type="secondary">Ожидание ответа: {candidate.timeoutMs} мс</Typography.Text></div>}
                    {localCodex?<Typography.Text type="secondary">Вход Codex остаётся на компьютере</Typography.Text>
                        :candidate.hasKey&&<Typography.Text type="secondary">Этот импорт не передаёт ключ с компьютера</Typography.Text>}
                    {candidate.parameterIssues?.length&&<div><Typography.Text type="secondary">Параметры без подтверждённого преобразования: {candidate.parameterIssues.map(item=>`${item.name} (${item.type})`).join(', ')}. Значения сохранены в исходном OpenCode на компьютере; автоматический импорт заблокирован.{!localCodex&&' Для серверного API задайте соответствующие поля в JSON параметров адаптера.'}</Typography.Text></div>}
                    {candidate.blocker&&!localCodex&&<div><Typography.Text type="secondary">{blocker[candidate.blocker]||'Настройте API вручную'}</Typography.Text></div>}
                    </div>
                <FeatureButton features={localCodex?['opencode_model_sync','codex_connector','device_codex_inference']:['opencode_model_sync']}
                    disabled={busy||!bridge.devicesReady||!!candidate.blocker&&!(localCodex&&candidate.blocker==='codex-local-auth'&&localCodexAvailable)||scanExpired}
                    onClick={()=>{void importCandidate(candidate);}}>{localCodex?'Подключить Codex':'Импортировать'}</FeatureButton>
            </List.Item>;}}/>
        </>}
    </Modal>;
}
