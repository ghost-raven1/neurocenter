import {useEffect,useMemo,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import base from '../../core/api/base';
import {OPENCODE_GLOBAL_PROVIDERS_READ_JOB as READ,OPENCODE_GLOBAL_PROVIDERS_CAPABILITY} from '@neurocenter/opencode-local-providers';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {durableJournalOwner} from '../UserBlock/durableJournalOwner';
import {roleLevel} from '../UserBlock/roles';
import type {useBridge} from '../McpBridge/useBridge';
import {browserCliJournalLock} from '../ComputerSetup/journalLock';
import {localProvidersApi} from './api';
import {createLocalProvidersController,type LocalProvidersState} from './controller';
import {terminal,uuid} from './model';

/** Durable identity survives changed grants; full auth scope and selected computer fence every asynchronous reply. */
export function useLocalProviders(bridge:ReturnType<typeof useBridge>,enabled:boolean,compatible:boolean){
    const user=useSelector((state:RootState)=>state.userBlock.user),{scope,captureOwner}=useAuthRequestOwner();
    const availability=useFeatureAvailability('computer_setup','computer_connections'),device=bridge.device,role=user?.activeRole??'';
    const owner=durableJournalOwner(user,base.defaults.baseURL||window.location.origin),deviceId=device?.id??'',identity=JSON.stringify([scope,deviceId]);
    const selected=useRef(identity);selected.current=identity;
    const assigned=!!user?.userRoles.includes(role),supported=!!device?.report.capabilities?.includes(OPENCODE_GLOBAL_PROVIDERS_CAPABILITY);
    const canRead=!!scope&&!!owner&&uuid(deviceId)&&assigned&&roleLevel(role)>=1&&roleLevel(device?.role??'')>=1&&bridge.devicesReady&&!bridge.errors.devices&&!!device?.online&&!device.requiresReconnect&&supported;
    const canOpen=compatible&&canRead&&enabled&&availability.enabled&&roleLevel(role)>=2&&roleLevel(device?.role??'')>=2;
    const permissions=useRef({canRead,canOpen});permissions.current={canRead,canOpen};
    const lock=useMemo(browserCliJournalLock,[]);
    const supportsJournal=!!lock&&!!globalThis.crypto?.subtle&&typeof globalThis.crypto?.randomUUID==='function';
    const [view,setView]=useState<{identity:string;state?:LocalProvidersState}>({identity});
    const controller=useMemo(()=>{
        let storage:Storage|undefined;try{storage=window.localStorage;}catch{/* Existing history remains readable without storage. */}
        return createLocalProvidersController({owner,role,deviceId,storage,lock,api:localProvidersApi,canRead:()=>permissions.current.canRead,canOpen:()=>permissions.current.canOpen,
            captureOwner:()=>{const owns=captureOwner();return()=>owns()&&selected.current===identity;},onChange:state=>setView({identity,state})});
    },[scope,owner,role,deviceId,lock,captureOwner]);
    useEffect(()=>{
        controller.activate();void controller.refresh().then(()=>{if(permissions.current.canRead&&supportsJournal&&!controller.state.denied&&!controller.state.jobs[READ]&&!controller.state.storageError&&!controller.state.canReplay)void controller.start(READ);});
        const changed=(event:StorageEvent)=>{if(event.key===null||event.key===controller.journalKey(READ)||event.key===controller.journalKey('open-opencode-global-providers'))controller.storageChanged();};window.addEventListener('storage',changed);
        return()=>{controller.dispose();window.removeEventListener('storage',changed);};
    },[controller]);
    const state=view.identity===identity?view.state:undefined;
    useEffect(()=>{
        if(!state||!Object.values(state.jobs).some(job=>job&&!terminal(job)))return;
        const timer=window.setInterval(()=>{if(document.visibilityState!=='hidden')void controller.refresh();},2500);return()=>window.clearInterval(timer);
    },[controller,state?.jobs]);
    const blocker=!device?'Выберите подключённый компьютер.':!supported?'Обновите мост: глобальное чтение провайдеров пока недоступно.':!canRead?'Подтвердите подключение компьютера и действующую роль для чтения.':'';
    const openingBlocker=!enabled||!availability.enabled?availability.reason||'Новая настройка выключена. Чтение, история и отмена доступны.':roleLevel(role)<2?'Локальная настройка доступна разработчику или администратору.':'';
    return{controller,state,canRead,canInspect:canRead&&supportsJournal,canOpen:canOpen&&supportsJournal,blocker:!supportsJournal?'Браузер не поддерживает защищённый журнал отправки. Историю можно читать.':blocker,openingBlocker};
}
