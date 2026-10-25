import api from '../../core/api/base';
import type {ChatSearchIntent,ChatSearchJob} from './types';
const route=(projectId:string):string=>'/api/projects/'+encodeURIComponent(projectId)+'/chat-search';
/** Status/history are read-only; explicit index/search requests retain the same key on an unknown ACK. */
export const chatSemanticApi={
    history:(projectId:string,signal:AbortSignal)=>api.get<{jobs:ChatSearchJob[]}>(route(projectId),{signal}).then(value=>value.data.jobs),
    read:(projectId:string,id:string,signal:AbortSignal)=>api.get<ChatSearchJob>(route(projectId)+'/jobs/'+encodeURIComponent(id),{signal}).then(value=>value.data),
    create:(projectId:string,kind:'index'|'search',input:ChatSearchIntent,signal:AbortSignal)=>api.post<ChatSearchJob>(route(projectId)+'/'+kind,input,{signal,timeout:30000}).then(value=>value.data),
    cancel:(projectId:string,id:string,signal:AbortSignal)=>api.delete<ChatSearchJob>(route(projectId)+'/jobs/'+encodeURIComponent(id),{signal}).then(value=>value.data),
};
