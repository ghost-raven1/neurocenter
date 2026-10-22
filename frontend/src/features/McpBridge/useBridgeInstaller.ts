import {useEffect,useState} from 'react';
import api from '../../core/api/base';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {readBridgeInstallerConfig,type IBridgeInstallerConfig,type IBridgeDevSupply} from './bridgeInstallerConfig';

export interface IBridgeInstaller {
    origin?:string;
    devSupply?:IBridgeDevSupply;
    loading:boolean;
    error:string;
    reload():void;
}

/** Публичный адрес Gateway приходит из runtime-конфигурации сервера, а не dev-прокси или адресной строки. */
async function loadBridgeInstallerConfig(signal:AbortSignal):Promise<IBridgeInstallerConfig> {
    const {data}=await api.get<unknown>('/api/bridge/config',{signal,timeout:10000});
    return readBridgeInstallerConfig(data);
}

/** Старые callers получают строковый origin, но повреждённая dev-поставка также отклоняется. */
export async function loadBridgeInstallerOrigin(signal:AbortSignal):Promise<string> {
    return(await loadBridgeInstallerConfig(signal)).origin;
}

/** Ошибка конфигурации оставляет повтор загрузки, без подмены Gateway адресом интерфейса. */
export function useBridgeInstaller(enabled=true):IBridgeInstaller {
    const {scope,captureOwner}=useAuthRequestOwner();
    const [state,setState]=useState<Omit<IBridgeInstaller,'reload'>&{scope:string}>({scope,loading:true,error:''});
    const [revision,setRevision]=useState(0);
    useEffect(()=>{
        if(!enabled){setState({scope,loading:false,error:''});return;}
        const owns=captureOwner();
        if(!owns())return;
        const controller=new AbortController();
        const current=()=>owns()&&!controller.signal.aborted;
        setState({scope,loading:true,error:''});
        void loadBridgeInstallerConfig(controller.signal).then(config=>{
            if(current()){setState({...config,scope,loading:false,error:''});}
        }).catch(()=>{
            if(current()){setState({scope,loading:false,error:'Не удалось получить настройки установщика из API Gateway. Повторите загрузку.'});}
        });
        return ()=>controller.abort();
    },[enabled,revision,scope,captureOwner]);
    return {...(enabled&&state.scope===scope?state:{loading:enabled,error:''}),reload:()=>{
        if(!captureOwner()())return;
        setState({scope,loading:true,error:''});
        setRevision(value=>value+1);
    }};
}
