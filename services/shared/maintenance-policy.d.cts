export interface MaintenanceWindow { days:number[]; start:string; end:string; }
export interface MaintenancePolicy { enabled:boolean; timeZone:string; schedule:{days:number[];time:string}; windows:MaintenanceWindow[]; maxPauseMinutes:number; localCopies:number; externalRetentionDays:number; rpoMinutes:number; rtoMinutes:number; }
export const defaultPolicy:MaintenancePolicy;
export function validateMaintenancePolicy(value:unknown):MaintenancePolicy;
export function nextMaintenanceRun(policy:MaintenancePolicy,after?:Date|string,excludedSlot?:string):{at:string;slot:string}|null;
export function dueMaintenanceRun(policy:MaintenancePolicy,now?:Date):{at:string;slot:string}|null;
export function inWindow(windows:MaintenanceWindow[],day:number,minute:number,duration?:number):boolean;
