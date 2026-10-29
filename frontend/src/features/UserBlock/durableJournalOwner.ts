interface JournalPrincipal {id?:string|number;email?:string;activeRole?:string;}

/** Durable request identity excludes mutable grants; live requests still use the full authDataScope fence. */
export function durableJournalOwner(principal:JournalPrincipal|null|undefined,apiBase:string):string{
    if(!principal?.email?.trim()||!principal.activeRole||!apiBase)return '';
    return JSON.stringify({api:apiBase.replace(/\/+$/,''),id:principal.id===undefined?null:String(principal.id),
        email:principal.email.trim().toLowerCase(),activeRole:principal.activeRole});
}
