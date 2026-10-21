import {useEffect,useState} from 'react';
import api from '../../core/api/base';

export interface IBridgeInstaller {
    origin?:string;
    loading:boolean;
    error:string;
    reload():void;
}

/** Публичный адрес Gateway приходит из runtime-конфигурации сервера, а не dev-прокси или адресной строки. */
export async function loadBridgeInstallerOrigin(signal:AbortSignal):Promise<string> {
    const {data}=await api.get<{origin:unknown}>('/api/bridge/config',{signal,timeout:10000});
    if(typeof data?.origin!=='string'){throw new Error('Gateway не сообщил адрес установщика.');}
    const url=new URL(data.origin);
    if(!['http:','https:'].includes(url.protocol)||url.origin!==data.origin){throw new Error('Gateway сообщил некорректный адрес установщика.');}
    return url.origin;
}

/** Ошибка конфигурации оставляет повтор загрузки, без подмены Gateway адресом интерфейса. */
export function useBridgeInstaller(enabled=true):IBridgeInstaller {
    const [state,setState]=useState<Omit<IBridgeInstaller,'reload'>>({loading:true,error:''});
    const [revision,setRevision]=useState(0);
    useEffect(()=>{
        if(!enabled){return;}
        const controller=new AbortController();
        setState({loading:true,error:''});
        void loadBridgeInstallerOrigin(controller.signal).then(origin=>{
            if(!controller.signal.aborted){setState({origin,loading:false,error:''});}
        }).catch(()=>{
            if(!controller.signal.aborted){setState({loading:false,error:'Не удалось получить адрес установщика из API Gateway. Повторите загрузку.'});}
        });
        return ()=>controller.abort();
    },[enabled,revision]);
    return {...state,reload:()=>setRevision(value=>value+1)};
}
