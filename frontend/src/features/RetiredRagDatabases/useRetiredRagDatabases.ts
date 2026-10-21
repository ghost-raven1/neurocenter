import {useCallback,useEffect,useRef,useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {retiredRagApi} from './api';
import type {IRetiredRagDatabase,IRetiredRagPreview} from './types';

/** Запросы и preview принадлежат одному auth scope; поздний ответ не переносится другому админу. */
export function useRetiredRagDatabases(){
    const [items,setItems]=useState<IRetiredRagDatabase[]>([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
    const [preview,setPreview]=useState<IRetiredRagPreview|null>(null),[selected,setSelected]=useState<IRetiredRagDatabase|null>(null);
    const alive=useRef(false),locked=useRef(false),request=useRef(0),abort=useRef<AbortController>(),purgeKey=useRef('');
    const refresh=useCallback(async()=>{
        const sequence=++request.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;setLoading(true);
        try{const values=await retiredRagApi.list(controller.signal);if(alive.current&&request.current===sequence){setItems(values);setError(null);}}
        catch(error){if(alive.current&&request.current===sequence&&!controller.signal.aborted){setError(errorMessage(error,'Не удалось прочитать сохранённые базы.'));if([401,403].includes((error as {response?:{status:number}}).response?.status??0)){setItems([]);setPreview(null);setSelected(null);}}}
        finally{if(alive.current&&request.current===sequence)setLoading(false);}
    },[]);
    useEffect(()=>{alive.current=true;void refresh();const timer=setInterval(()=>{if(!locked.current)void refresh();},5000);return()=>{alive.current=false;request.current++;abort.current?.abort();clearInterval(timer);};},[refresh]);
    const perform=async(action:()=>Promise<void>)=>{if(locked.current||!alive.current)return;locked.current=true;setBusy(true);setError(null);
        try{await action();if(alive.current)await refresh();}catch(error){if(alive.current)setError(errorMessage(error,'Действие не подтверждено. Обновите сведения и проверьте результат.'));}
        finally{locked.current=false;if(alive.current)setBusy(false);}};
    return {items,loading,busy,error,preview,selected,refresh,
        open:(row:IRetiredRagDatabase)=>perform(async()=>{const plan=await retiredRagApi.preview(row.id);if(alive.current){purgeKey.current=crypto.randomUUID();setSelected(row);setPreview(plan);}}),
        close:()=>{if(!locked.current){setPreview(null);setSelected(null);}},
        purge:()=>perform(async()=>{if(!preview||!selected)return;await retiredRagApi.purge(selected.id,preview,purgeKey.current);if(alive.current){setPreview(null);setSelected(null);}}),
        retry:(row:IRetiredRagDatabase)=>perform(async()=>{if(row.job)await retiredRagApi.retry(row.job);}),
        retention:(row:IRetiredRagDatabase,date:string|null,reason:string)=>perform(async()=>{await retiredRagApi.retention(row,date,reason);}),
    };
}
