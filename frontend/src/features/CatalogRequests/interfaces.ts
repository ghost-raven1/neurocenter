export type TRequestKind = 'add' | 'update' | 'issue';
export type TRequestAssetType = 'plugin' | 'mcp' | 'skill' | 'model';
export type TRequestStatus = 'submitted' | 'in_progress' | 'needs_info' | 'completed' | 'rejected' | 'cancelled';
export type TRequestAction = 'start' | 'needs_info' | 'reject' | 'complete' | 'resubmit' | 'cancel';
export interface IRequestTargetRef {
    type: TRequestAssetType;
    id: string;
}
export interface IRequestTarget extends IRequestTargetRef {
    name: string;
    version: number;
    available: boolean | null;
}
export interface ICatalogRequest {
    id: string;
    kind: TRequestKind;
    assetType: TRequestAssetType;
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
    permissions: { canEdit: boolean; canCancel: boolean; canReview: boolean; canResubmit: boolean };
}
export interface IRequestHistory {
    id: string;
    action: string;
    actor: string;
    comment: string | null;
    fromStatus: TRequestStatus | null;
    toStatus: TRequestStatus;
    revision: number;
    at: string;
}
export interface IRequestDetail extends ICatalogRequest {
    history: IRequestHistory[];
}
export interface IRequestPage {
    items: ICatalogRequest[];
    total: number;
    page: number;
    size: number;
}
export interface IRequestFilters {
    scope: 'mine' | 'all';
    status?: TRequestStatus;
    kind?: TRequestKind;
    assetType?: TRequestAssetType;
    projectId?: string;
    page: number;
    size: number;
}
export interface IRequestCreate {
    kind: TRequestKind;
    assetType: TRequestAssetType;
    title: string;
    description: string;
    sourceUrl?: string | null;
    projectId?: string | null;
    target?: IRequestTargetRef;
}
export interface IRequestEdit {
    title: string;
    description: string;
    sourceUrl?: string | null;
    target?: IRequestTargetRef;
}
export interface IRequestMutation {
    action: TRequestAction;
    comment?: string;
    target?: IRequestTargetRef;
}
export interface IRequestProject {
    id: string;
    name: string;
}
