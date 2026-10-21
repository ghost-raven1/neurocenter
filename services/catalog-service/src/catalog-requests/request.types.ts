import type {IAccessActor,IAccessClaims} from '../access/access.model';

export type RequestKind='add'|'update'|'issue';
export type AssetType='plugin'|'mcp'|'skill'|'model';
export type RequestStatus='submitted'|'in_progress'|'needs_info'|'rejected'|'completed'|'cancelled';
export type RequestAction='start'|'needs_info'|'reject'|'complete'|'resubmit'|'cancel';
export interface RequestTarget {type:AssetType;id:string;name:string;version:number;available:boolean|null}
export interface TargetInput {type:AssetType;id:string}
export interface RequestFields {title:string;description:string;sourceUrl:string|null;target:TargetInput|null}
export interface CreateRequest extends RequestFields {requestKey:string;kind:RequestKind;assetType:AssetType;projectId:string|null}
export interface EditRequest extends RequestFields {requestKey:string;expectedRevision:number}
export interface ActionRequest {requestKey:string;expectedRevision:number;action:RequestAction;comment:string;target:TargetInput|null}
export interface CreateRequestBody {requestKey:string;kind:RequestKind;assetType:AssetType;title:string;description:string;sourceUrl?:string|null;projectId?:string|null;target?:TargetInput|null}
export interface EditRequestBody {requestKey:string;expectedRevision:number;title:string;description:string;sourceUrl?:string|null;target?:TargetInput|null}
export interface ActionRequestBody {requestKey:string;expectedRevision:number;action:RequestAction;comment?:string;target?:TargetInput|null}
export interface RequestListQuery {scope?:'mine'|'all';status?:RequestStatus;kind?:RequestKind;assetType?:AssetType;projectId?:string;page?:string;size?:string}
export interface TargetListQuery {assetType:AssetType;projectId?:string;q?:string;limit?:string}
export interface RequestPermissions {canEdit:boolean;canCancel:boolean;canReview:boolean;canResubmit:boolean}
export interface CatalogRequest {
 id:string;kind:RequestKind;assetType:AssetType;title:string;description:string;sourceUrl:string|null;
 projectId:string|null;projectName:string|null;createdBy:string;status:RequestStatus;revision:number;
 createdAt:string;updatedAt:string;target:RequestTarget|null;permissions:RequestPermissions;
}
export interface RequestEvent {id:string;action:string;actor:string;comment:string;fromStatus:RequestStatus|null;toStatus:RequestStatus;revision:number;at:string}
export interface RequestDetail extends CatalogRequest {history:RequestEvent[]}
export interface RequestList {items:CatalogRequest[];total:number;page:number;size:number}
export interface RequestFilter {scope:'mine'|'all';status?:RequestStatus;kind?:RequestKind;assetType?:AssetType;projectId?:string;page:number;size:number}
export interface RequestActor extends IAccessActor {claims:IAccessClaims}
export interface RequestRow {
 id:string;kind:RequestKind;asset_type:AssetType;title:string;description:string;source_url:string|null;
 project_id:string|null;project_name:string|null;created_by:string;status:RequestStatus;revision:number;
 created_at:Date;updated_at:Date;target:RequestTarget|null;
}
