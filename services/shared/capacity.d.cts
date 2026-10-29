export type CapacityResource='postgres'|'wal'|'skills'|'projects'|'backups'|'runtime-artifacts';
export interface CapacityRequest {resource:CapacityResource;bytes:number;path?:string;}
export class CapacityError extends Error {constructor(code:string,resource:CapacityResource);code:string;resource:CapacityResource;statusCode:number;}
export const reserveBytes:number;
/** Резерв до записи освобождается в finally; production требует свежий замер реальных томов. */
export function reserveCapacity(request:CapacityRequest):Promise<()=>void>;
export function recordCapacityQueue(name:'rag',pending:number,active:number):void;
export function renderCapacityMetrics():string;
export function getCapacityStatus():{available:boolean;reason?:string;observedAt?:string;maxAgeSeconds?:number;reserveBytes?:number;resources?:Record<CapacityResource,{available:true;filesystem:string;freeBytes:number;totalBytes:number;walBytes?:number}>};
