export type IRequestKind = 'add' | 'update' | 'issue';
export type IRequestAssetType = 'plugin' | 'mcp' | 'skill' | 'model';
export type IRequestStatus = 'submitted' | 'in_progress' | 'needs_info' | 'completed' | 'rejected' | 'cancelled';
export type IRequestAction = 'start' | 'needs_info' | 'reject' | 'complete' | 'resubmit' | 'cancel';
export interface IRequestTargetRef {type:IRequestAssetType;id:string}
export interface IRequestTarget extends IRequestTargetRef {name:string;version:number;available:boolean|null}
export interface ICatalogRequest {
    id:string;kind:IRequestKind;assetType:IRequestAssetType;title:string;description:string;sourceUrl:string|null;
    projectId:string|null;projectName:string|null;createdBy:string;status:IRequestStatus;revision:number;createdAt:string;updatedAt:string;
    target:IRequestTarget|null;permissions:{canEdit:boolean;canCancel:boolean;canReview:boolean;canResubmit:boolean};
}
export interface IRequestHistory {id:string;action:string;actor:string;comment:string|null;fromStatus:IRequestStatus|null;toStatus:IRequestStatus;revision:number;at:string}
export interface IRequestDetail extends ICatalogRequest {history:IRequestHistory[]}
export interface IRequestPage {items:ICatalogRequest[];total:number;page:number;size:number}
export interface IRequestFilters {scope:'mine'|'all';status?:IRequestStatus;kind?:IRequestKind;assetType?:IRequestAssetType;projectId?:string;page:number;size:number}
export interface IRequestCreate {kind:IRequestKind;assetType:IRequestAssetType;title:string;description:string;sourceUrl?:string|null;projectId?:string|null;target?:IRequestTargetRef}
export interface IRequestEdit {title:string;description:string;sourceUrl?:string|null;target?:IRequestTargetRef}
export interface IRequestMutation {action:IRequestAction;comment?:string;target?:IRequestTargetRef}
export interface IRequestProject {id:string;name:string}
