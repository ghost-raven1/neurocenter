export const DEV_TRACE_KIND:'neurocenter-dev-trace';
export const TOOL_BUILD_TRACE_EVENTS:readonly ['requested','accepted','replayed','started','cancel-requested','succeeded','failed','cancelled'];
export const SAVED_CHAT_TRACE_EVENTS:readonly ['accepted','retried','started','cancel-requested','succeeded','failed','cancelled'];
export interface DevTraceOptions {environment?:NodeJS.ProcessEnv;write?:(line:string)=>unknown;now?:()=>Date}
/** The writer is best effort and copies only the declared UUID identities. */
export function traceToolBuild(event:typeof TOOL_BUILD_TRACE_EVENTS[number],ids:{requestKey:string;buildId?:string},options?:DevTraceOptions):boolean;
export function traceSavedChat(event:typeof SAVED_CHAT_TRACE_EVENTS[number],ids:{conversationId:string;turnId:string;requestId:string},options?:DevTraceOptions):boolean;
