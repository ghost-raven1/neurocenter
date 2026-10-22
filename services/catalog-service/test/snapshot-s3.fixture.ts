/** Explicit caller-owned fixture configuration; never contacts a server or reuses application buckets. */
export function snapshotS3FixtureConfiguration(value:unknown):{endpoint:string;port:number;region:string;accessKey:string;secretKey:string}{
    const raw=value as Record<string,unknown>|null;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.CHAT_S3_ENDPOINT!=='string')throw new Error('Incomplete explicit snapshot S3 fixture configuration.');
    let url:URL;try{url=new URL(raw.CHAT_S3_ENDPOINT);}catch{throw new Error('Invalid explicit snapshot S3 fixture endpoint.');}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.port==='19010'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
        throw new Error('Snapshot S3 fixture requires an explicitly owned 127.0.0.1 HTTP port other than19010, without credentials or URL suffixes.');
    for(const name of ['CHAT_S3_REGION','CHAT_S3_ACCESS_KEY','CHAT_S3_SECRET_KEY','CHAT_S3_PROJECT_BUCKET','CHAT_S3_PERSONAL_BUCKET'])
        if(typeof raw[name]!=='string'||!(raw[name] as string).trim())throw new Error('Incomplete explicit snapshot S3 fixture configuration.');
    if(raw.CHAT_S3_PROJECT_BUCKET===raw.CHAT_S3_PERSONAL_BUCKET)throw new Error('Snapshot S3 fixture requires distinct private project and personal buckets.');
    return {endpoint:url.origin,port:Number(url.port),region:raw.CHAT_S3_REGION as string,accessKey:raw.CHAT_S3_ACCESS_KEY as string,secretKey:raw.CHAT_S3_SECRET_KEY as string};
}
