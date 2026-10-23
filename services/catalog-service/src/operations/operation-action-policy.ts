/** Only executors with durable step/response journals can cancel after bridge admission. */
export function canCancelBridgeJob(kind:string,state:string):boolean{
    return state==='queued'||['sync-learning-memory','import-learning-quirks','infer-device-codex'].includes(kind)&&['running','reconciling'].includes(state);
}
