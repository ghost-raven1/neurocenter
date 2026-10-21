/** Retries reuse their intent key; changing the payload or revision starts a new intent. */
export function createRequestKeys() {
    const keys = new Map<string,string>();
    return {
        forIntent(operation:string,payload:unknown):string {
            const signature=JSON.stringify([operation,payload]);
            let key=keys.get(signature);
            if(!key){key=crypto.randomUUID();keys.set(signature,key);}
            return key;
        },
        clear():void{keys.clear();},
    };
}
