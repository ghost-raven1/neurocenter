import {useEffect,useMemo,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {packagingApi} from '../../modules/Store/packaging/api';

/** Проверка имени не отправляет сборку и не превращает совпадение в согласие на обновление. */
export function useBundledNameCheck(scope:string,name:string,kind:string|undefined,enabled:boolean,captureOwner:()=>()=>boolean){
    const [state,setState]=useState({loading:false,error:''});
    const owner=useMemo(()=>({}),[scope,name,kind,enabled,captureOwner]);
    const current=useRef(owner);current.current=owner;
    const flight=useRef<AbortController>();
    useEffect(()=>{setState({loading:false,error:''});return()=>flight.current?.abort();},[owner]);
    const check=async(onAvailable:()=>void,onMatch:(target:{catalogId:string;kind:'mcp'|'plugin'})=>void):Promise<void>=>{
        const owns=captureOwner();
        if(!enabled||current.current!==owner||!owns()||flight.current&&!flight.current.signal.aborted)return;
        const controller=new AbortController();flight.current=controller;
        const active=()=>current.current===owner&&owns()&&!controller.signal.aborted;
        setState({loading:true,error:''});
        try{
            const match=await packagingApi.publicationConflict(name.trim(),controller.signal);
            if(!active())return;
            if(!match)onAvailable();
            else if(match.archived)setState({loading:false,error:'Инструмент с этим названием находится в архиве. Верните карточку из архива или укажите другое название; исходники сохранены.'});
            else if(match.kind!==kind)setState({loading:false,error:'Это название занято инструментом другого типа. Укажите другое название; исходники сохранены.'});
            else onMatch({catalogId:match.catalogId,kind:match.kind});
        }catch(cause){if(active())setState({loading:false,error:errorMessage(cause,'Не удалось проверить название. Повторите подготовку; исходники сохранены.')});}
        finally{if(flight.current===controller)flight.current=undefined;if(active())setState(value=>({...value,loading:false}));}
    };
    return {...state,check};
}
