import type {WorkflowIntent} from './model';

/** Matches the server's enqueue hash, retaining the original role and nested origin exactly. */
export async function workflowFingerprint(input:WorkflowIntent,actorRole:string):Promise<string>{
    if(!globalThis.crypto?.subtle)throw Error('Браузер не может проверить исходный запрос. Откройте Нейроцентр по HTTPS или через localhost.');
    const raw=JSON.stringify({role:actorRole,request:Object.entries(input).sort(([a],[b])=>a.localeCompare(b))});
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
}

export function workflowActorRole(scope:string):string{
    try{const value=JSON.parse(scope) as {activeRole?:unknown};if(typeof value?.activeRole==='string'&&value.activeRole)return value.activeRole;}catch{/* Unknown test/session scopes stay isolated. */}
    return scope;
}
