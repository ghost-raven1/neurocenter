/** Сохраняет шаг подключения после входа, разрешая только маршруты этой площадки. */
export function loginReturn(value:unknown):string {
    if(typeof value!=='string'||value.length>2048||!value.startsWith('/')||value.startsWith('//')||/[\\\x00-\x20]/.test(value)){return '/';}
    try{
        const url=new URL(value,'http://panel.invalid');
        if(url.origin!=='http://panel.invalid'||!/^\/(?:start|projects|store|assets|rag|maintenance|audit|access|model-usage)?(?:\/|$)/.test(url.pathname)){return '/';}
        return url.pathname+url.search;
    }catch{return '/';}
}
