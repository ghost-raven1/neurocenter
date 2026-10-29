import api from '../../core/api/base';
import {personalProviderReceipt,personalProviderView,type PersonalProviderIntent} from './model';
const path=(id:string)=>`/api/models/${encodeURIComponent(id)}/my-access`;
export const personalProviderApi={
    read:async(id:string,signal?:AbortSignal)=>personalProviderView((await api.get(path(id),{signal,timeout:10000})).data,id),
    receipt:async(id:string,key:string,signal?:AbortSignal)=>{
        const value:unknown=(await api.get(`${path(id)}/requests/${encodeURIComponent(key)}`,{signal,timeout:10000})).data;
        return value===null?null:personalProviderReceipt(value,id);
    },
    write:async(id:string,intent:PersonalProviderIntent,secret:string,signal?:AbortSignal)=>{
        const {version:_version,action,...identity}=intent;
        const request={...identity,...(action==='save'?{apiKey:secret}:{})};
        const response=action==='save'?await api.put(path(id),request,{signal,timeout:15000}):await api.delete(path(id),{data:request,signal,timeout:15000});
        return personalProviderReceipt(response.data,id);
    },
};
export type PersonalProviderApi=typeof personalProviderApi;
