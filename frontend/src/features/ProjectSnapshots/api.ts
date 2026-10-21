import base from '../../core/api/base';
import type {ProjectSnapshot,SnapshotCapabilities,SnapshotIntent,SnapshotProfile,SnapshotReceipt} from './types';
const root=(projectId:string)=>'/api/projects/'+encodeURIComponent(projectId);
const options=(signal?:AbortSignal)=>({signal,timeout:10000});
/** Every retry sends the original durable input, including its UUID and CAS revisions. */
export const projectSnapshotsApi={
    list:async(projectId:string,signal?:AbortSignal)=>(await base.get<ProjectSnapshot[]>(root(projectId)+'/versions',options(signal))).data,
    profiles:async(projectId:string,signal?:AbortSignal)=>(await base.get<SnapshotProfile[]>(root(projectId)+'/profiles',options(signal))).data,
    capabilities:async(projectId:string,signal?:AbortSignal)=>(await base.get<SnapshotCapabilities>(root(projectId)+'/versions/capabilities',options(signal))).data,
    async submit(intent:SnapshotIntent,signal?:AbortSignal):Promise<SnapshotReceipt>{
        const url=root(intent.projectId),config={signal,timeout:30000};
        if(intent.kind==='create')return(await base.post<ProjectSnapshot>(url+'/versions',intent.input,config)).data;
        if(intent.kind==='release')return(await base.post<SnapshotReceipt>(url+'/release-profile',intent.input,config)).data;
        const target=url+'/versions/'+encodeURIComponent(intent.snapshotId);
        if(intent.kind==='delete')return(await base.delete<SnapshotReceipt>(target,{...config,data:intent.input})).data;
        return(await base.post<SnapshotReceipt>(target+'/'+intent.kind,intent.input,config)).data;
    },
    async lookup(intent:SnapshotIntent,signal?:AbortSignal):Promise<SnapshotReceipt|null>{
        const url=root(intent.projectId)+'/versions/'+(intent.kind==='create'?'requests/':'commands/')+encodeURIComponent(intent.input.requestKey);
        if(intent.kind==='create')return(await base.get<ProjectSnapshot|null>(url,options(signal))).data;
        const receipt=(await base.get<{result:SnapshotReceipt}|null>(url,options(signal))).data;
        return receipt?.result??null;
    },
    async cancelRequest(intent:SnapshotIntent,signal?:AbortSignal):Promise<void>{
        const url=root(intent.projectId)+'/versions/'+(intent.kind==='create'?'requests/':'commands/')+encodeURIComponent(intent.input.requestKey)+'/cancel';
        await base.post(url,intent.kind==='create'?intent.input:undefined,{signal,timeout:10000});
    },
    manifestUrl:(projectId:string,snapshotId:string)=>base.getUri({url:root(projectId)+'/versions/'+encodeURIComponent(snapshotId)+'/manifest'}),
    profileUrl:(projectId:string,profileId:string)=>base.getUri({url:root(projectId)+'/profiles/'+encodeURIComponent(profileId)}),
};
