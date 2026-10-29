/** Journaled actions and the bounded read-only CLI probe can stop after bridge admission. */
export function canCancelBridgeJob(kind:string,state:string):boolean{
    return state==='queued'||['sync-learning-memory','import-learning-quirks','infer-device-codex','inspect-opencode-cli'].includes(kind)&&['running','reconciling'].includes(state);
}
