import {useEffect,useRef,useState} from 'react';
import {baseApi} from '../../core/api';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {assetArchiveError} from './archiveUpload';
import type {ISourceList} from './types';

interface UploadOptions {blocked:()=>boolean;onStart:()=>void;onFinish:()=>void;onSuccess:(data:ISourceList)=>void}
interface UploadState {scope:string;stage:'idle'|'uploading'|'validating';percent:number;error:string}

/** One raw upload owns its progress/result; cancel, unmount and owner changes fence every callback. */
export function useAssetArchiveUpload(options:UploadOptions) {
    const {scope,captureOwner}=useAuthRequestOwner();
    const [state,setState]=useState<UploadState>({scope,stage:'idle',percent:0,error:''});
    const request=useRef<AbortController>(),callbacks=useRef(options);callbacks.current=options;
    useEffect(()=>{
        setState({scope,stage:'idle',percent:0,error:''});
        return()=>{const active=request.current;request.current=undefined;active?.abort();};
    },[scope,captureOwner]);
    const upload=async(file:File):Promise<boolean>=>{
        const owns=captureOwner();if(!owns()||request.current||callbacks.current.blocked())return false;
        const error=assetArchiveError(file);if(error){setState({scope,stage:'idle',percent:0,error});return false;}
        const controller=new AbortController();request.current=controller;
        const current=()=>owns()&&!controller.signal.aborted&&request.current===controller;
        setState({scope,stage:'uploading',percent:0,error:''});callbacks.current.onStart();
        try{
            const {data}=await baseApi.put<ISourceList>('/api/asset-sources/archive',file,{signal:controller.signal,timeout:30*60*1000,
                headers:{'Content-Type':'application/octet-stream'},onUploadProgress:event=>{
                    if(current())setState({scope,stage:event.loaded>=file.size?'validating':'uploading',percent:Math.min(100,Math.floor(event.loaded/file.size*100)),error:''});
                }});
            if(!current())return false;
            callbacks.current.onSuccess(data);setState({scope,stage:'idle',percent:100,error:''});return true;
        }catch(cause){
            if(current())setState({scope,stage:'idle',percent:0,error:errorMessage(cause,'Не удалось импортировать архив. Сохранённый список ассетов доступен; можно повторить загрузку.')});
            return false;
        }finally{
            if(request.current===controller){request.current=undefined;if(owns())callbacks.current.onFinish();}
        }
    };
    const cancel=():void=>{if(!captureOwner()())return;const active=request.current;request.current=undefined;active?.abort();callbacks.current.onFinish();setState({scope,stage:'idle',percent:0,error:''});};
    return {stage:state.scope===scope?state.stage:'idle',percent:state.scope===scope?state.percent:0,error:state.scope===scope?state.error:'',
        busy:state.scope===scope&&state.stage!=='idle',upload,cancel};
}
