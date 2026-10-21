import base from '../../core/api/base';
import type {IRequestCreate,IRequestDetail,IRequestEdit,IRequestFilters,IRequestMutation,IRequestPage,IRequestTarget,IRequestAssetType} from './types';
const root='/api/catalog-requests';
const requestPath=(id:string):string=>root+'/'+encodeURIComponent(id);

/** Intake mutations are explicit intents; a retry carries the same key and expected revision. */
export const catalogRequestsApi={
    list:(filters:IRequestFilters):Promise<IRequestPage>=>base.get<IRequestPage>(root,{params:filters}).then(result=>result.data),
    get:(id:string):Promise<IRequestDetail>=>base.get<IRequestDetail>(requestPath(id)).then(result=>result.data),
    targets:(assetType:IRequestAssetType,projectId?:string|null,q?:string):Promise<{items:IRequestTarget[]}>=>base.get<{items:IRequestTarget[]}>(root+'/targets',{params:{assetType,projectId:projectId||undefined,q,limit:100}}).then(result=>result.data),
    create:(input:IRequestCreate,requestKey:string):Promise<IRequestDetail>=>base.post<IRequestDetail>(root,{...input,requestKey}).then(result=>result.data),
    edit:(id:string,input:IRequestEdit,expectedRevision:number,requestKey:string):Promise<IRequestDetail>=>base.patch<IRequestDetail>(requestPath(id),{...input,expectedRevision,requestKey}).then(result=>result.data),
    action:(id:string,input:IRequestMutation,expectedRevision:number,requestKey:string):Promise<IRequestDetail>=>base.post<IRequestDetail>(requestPath(id)+'/actions',{...input,expectedRevision,requestKey}).then(result=>result.data),
};
