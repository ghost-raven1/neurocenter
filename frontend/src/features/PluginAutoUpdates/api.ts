import api from '../../core/api/base';
export interface PluginUpdateTarget {deviceId:string;projectId:string;bindingId:string;assetId:string;}
export interface PluginUpdatePolicy {id:string;enabled:boolean;revision:number;status:string;message:string;checkedAt:string|null;nextCheckAt:string|null;job?:{id:string;state:string;message:string};}
export interface PluginUpdateMutation extends PluginUpdateTarget {enabled:boolean;expectedRevision:number;requestKey:string;}
export const pluginAutoUpdateApi={
 read:(target:PluginUpdateTarget,signal:AbortSignal)=>api.get<{policy:PluginUpdatePolicy|null}>('/api/plugin-auto-updates',{params:target,signal,timeout:10000}).then(value=>value.data.policy),
 save:(input:PluginUpdateMutation,signal:AbortSignal)=>api.put<{policy:PluginUpdatePolicy}>('/api/plugin-auto-updates',input,{signal,timeout:15000}).then(value=>value.data.policy),
};
