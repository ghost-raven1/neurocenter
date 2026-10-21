import base from '../../../core/api/base';
import type {RestoreIntent,RestoreJob,RestoreStatus} from './types';
const root='/api/maintenance/restore';
/** Mutations всегда повторяют exact requestKey; потерянный ответ проверяется отдельным read. */
export const webRestoreApi={
 status:()=>base.get<RestoreStatus>(root).then(response=>response.data),
 request:(key:string)=>base.get<RestoreJob>(root+'/requests/'+encodeURIComponent(key)).then(response=>response.data),
 submit:(intent:RestoreIntent)=>base.post<RestoreJob>(root+(intent.kind==='preview'?'/previews':''),intent.input).then(response=>response.data),
 cancel:(id:string)=>base.post<RestoreJob>(root+'/jobs/'+encodeURIComponent(id)+'/cancel',{}).then(response=>response.data),
 cancelRequest:(key:string)=>base.post<{cancelled:true}>(root+'/requests/'+encodeURIComponent(key)+'/cancel',{}).then(response=>response.data),
};
