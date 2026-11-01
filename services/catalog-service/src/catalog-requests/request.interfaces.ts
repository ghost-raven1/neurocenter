import type { IAccessActor, IAccessClaims } from '../access/access.model';

export type TRequestKind = 'add' | 'update' | 'issue';
export type TAssetType = 'plugin' | 'mcp' | 'skill' | 'model';
export type TRequestStatus = 'submitted' | 'in_progress' | 'needs_info' | 'rejected' | 'completed' | 'cancelled';
export type TRequestAction = 'start' | 'needs_info' | 'reject' | 'complete' | 'resubmit' | 'cancel';
export interface IRequestTarget {
    type: TAssetType;
    id: string;
    name: string;
    version: number;
    available: boolean | null;
}
export interface ITargetInput {
    type: TAssetType;
    id: string;
}
export interface IRequestFields {
    title: string;
    description: string;
    sourceUrl: string | null;
    target: ITargetInput | null;
}
export interface ICreateRequest extends IRequestFields {
    requestKey: string;
    kind: TRequestKind;
    assetType: TAssetType;
    projectId: string | null;
}
export interface IEditRequest extends IRequestFields {
    requestKey: string;
    expectedRevision: number;
}
export interface IActionRequest {
    requestKey: string;
    expectedRevision: number;
    action: TRequestAction;
    comment: string;
    target: ITargetInput | null;
}
export interface ICreateRequestBody {
    requestKey: string;
    kind: TRequestKind;
    assetType: TAssetType;
    title: string;
    description: string;
    sourceUrl?: string | null;
    projectId?: string | null;
    target?: ITargetInput | null;
}
export interface IEditRequestBody {
    requestKey: string;
    expectedRevision: number;
    title: string;
    description: string;
    sourceUrl?: string | null;
    target?: ITargetInput | null;
}
export interface IActionRequestBody {
    requestKey: string;
    expectedRevision: number;
    action: TRequestAction;
    comment?: string;
    target?: ITargetInput | null;
}
export interface IRequestListQuery {
    scope?: 'mine' | 'all';
    status?: TRequestStatus;
    kind?: TRequestKind;
    assetType?: TAssetType;
    projectId?: string;
    page?: string;
    size?: string;
}
export interface ITargetListQuery {
    assetType: TAssetType;
    projectId?: string;
    q?: string;
    limit?: string;
}
export interface IRequestPermissions {
    canEdit: boolean;
    canCancel: boolean;
    canReview: boolean;
    canResubmit: boolean;
}
export interface ICatalogRequest {
    id: string;
    kind: TRequestKind;
    assetType: TAssetType;
    title: string;
    description: string;
    sourceUrl: string | null;
    projectId: string | null;
    projectName: string | null;
    createdBy: string;
    status: TRequestStatus;
    revision: number;
    createdAt: string;
    updatedAt: string;
    target: IRequestTarget | null;
    permissions: IRequestPermissions;
}
export interface IRequestEvent {
    id: string;
    action: string;
    actor: string;
    comment: string;
    fromStatus: TRequestStatus | null;
    toStatus: TRequestStatus;
    revision: number;
    at: string;
}
export interface IRequestDetail extends ICatalogRequest {
    history: IRequestEvent[];
}
export interface IRequestList {
    items: ICatalogRequest[];
    total: number;
    page: number;
    size: number;
}
export interface IRequestFilter {
    scope: 'mine' | 'all';
    status?: TRequestStatus;
    kind?: TRequestKind;
    assetType?: TAssetType;
    projectId?: string;
    page: number;
    size: number;
}
export interface IRequestActor extends IAccessActor {
    claims: IAccessClaims;
}
export interface IRequestRow {
    id: string;
    kind: TRequestKind;
    asset_type: TAssetType;
    title: string;
    description: string;
    source_url: string | null;
    project_id: string | null;
    project_name: string | null;
    created_by: string;
    status: TRequestStatus;
    revision: number;
    created_at: Date;
    updated_at: Date;
    target: IRequestTarget | null;
}
