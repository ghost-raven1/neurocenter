import {useEffect,useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {bridgeArchiveRequest,readBridgeArchive,type IBridgeArchive,type IBridgeArchiveSupply} from './bridgeArchive';

/** Public metadata is read without credentials; late responses cannot cross actor, origin or generation changes. */
export function useBridgeArchive(origin:string|undefined,supply:IBridgeArchiveSupply|undefined,target:string|undefined) {
    const {scope,captureOwner}=useAuthRequestOwner(),[revision,setRevision]=useState(0);
    const key=JSON.stringify([origin,supply?.version,supply?.buildId,supply?.targets,target]);
    const [state,setState]=useState<{scope:string;key:string;loading:boolean;archive?:IBridgeArchive;error:string}>({scope,key,loading:false,error:''});
    useEffect(()=>{
        const owns=captureOwner();if(!owns())return;
        if(!origin||!supply||!target){setState({scope,key,loading:false,error:''});return;}
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
        let disposed=false;
        const current=()=>owns()&&!controller.signal.aborted;
        setState({scope,key,loading:true,error:''});
        void(async()=>{
            try{
                const expected=bridgeArchiveRequest(origin,supply,target);
                const response=await fetch(`${origin}/api/bridge/runtime/${expected.file}.json`,{signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});
                if(!response.ok)throw Error('Метаданные архива недоступны. Повторите загрузку.');
                const archive=readBridgeArchive(await response.json(),expected);
                if(current())setState({scope,key,loading:false,error:'',archive});
            }catch{
                if(owns()&&(!controller.signal.aborted||!disposed))setState({scope,key,loading:false,error:'Не удалось подтвердить выбранный архив. Повторите загрузку или обновите поставку.'});
            }finally{clearTimeout(timer);}
        })();
        return()=>{disposed=true;clearTimeout(timer);controller.abort();};
    },[key,scope,revision,captureOwner,origin,supply,target]);
    return{...(state.scope===scope&&state.key===key?state:{loading:!!origin&&!!supply&&!!target,error:'',archive:undefined}),reload:()=>{if(!captureOwner()())return;setState({scope,key,loading:!!origin&&!!supply&&!!target,error:''});setRevision(value=>value+1);}};
}
