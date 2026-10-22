import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import * as http from 'node:http';
import {Client} from 'minio';

const {ownedTestPostgresAdmin}=createRequire(import.meta.url)('../../../scripts/test/owned-postgres.fixture.mjs') as {ownedTestPostgresAdmin:(value:string)=>URL};

/** Explicit caller-owned fixture configuration; never contacts a server or reuses application buckets. */
export function snapshotS3FixtureConfiguration(value:unknown):{endpoint:string;port:number;region:string;accessKey:string;secretKey:string}{
    const raw=value as Record<string,unknown>|null;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.CHAT_S3_ENDPOINT!=='string')throw new Error('Incomplete explicit snapshot S3 fixture configuration.');
    let url:URL;try{url=new URL(raw.CHAT_S3_ENDPOINT);}catch{throw new Error('Invalid explicit snapshot S3 fixture endpoint.');}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||['0','19010','19011'].includes(url.port)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
        throw new Error('Snapshot S3 fixture requires an explicitly owned 127.0.0.1 HTTP port other than19010/19011, without credentials or URL suffixes.');
    for(const name of ['CHAT_S3_REGION','CHAT_S3_ACCESS_KEY','CHAT_S3_SECRET_KEY','CHAT_S3_PROJECT_BUCKET','CHAT_S3_PERSONAL_BUCKET'])
        if(typeof raw[name]!=='string'||!(raw[name] as string).trim())throw new Error('Incomplete explicit snapshot S3 fixture configuration.');
    if(raw.CHAT_S3_PROJECT_BUCKET===raw.CHAT_S3_PERSONAL_BUCKET)throw new Error('Snapshot S3 fixture requires distinct private project and personal buckets.');
    return {endpoint:url.origin,port:Number(url.port),region:raw.CHAT_S3_REGION as string,accessKey:raw.CHAT_S3_ACCESS_KEY as string,secretKey:raw.CHAT_S3_SECRET_KEY as string};
}

/** Admit a fixture admin before constructing its pool. */
export function snapshotS3FixtureAdmin(value:string):URL{
    return ownedTestPostgresAdmin(value);
}

/** Check availability before allocating the per-test database and bucket. */
export async function snapshotS3FixturePreflight(value:unknown):Promise<void>{
    const {port,region,accessKey,secretKey}=snapshotS3FixtureConfiguration(value);
    const request=((...args:Parameters<typeof http.request>)=>{
        const outgoing=http.request(...args),timer=setTimeout(()=>outgoing.destroy(new Error('snapshot-s3-readiness-timeout')),1000);timer.unref();
        outgoing.once('close',()=>clearTimeout(timer));return outgoing;
    }) as typeof http.request;
    const client=new Client({endPoint:'127.0.0.1',port,useSSL:false,region,accessKey,secretKey,pathStyle:true,transport:{request},retryOptions:{disableRetry:true}});
    const bucket='snapshot-readiness-'+randomUUID().replaceAll('-','');
    for(let attempt=0;;attempt++){
        try{await client.bucketExists(bucket);return;}catch{}
        if(attempt>=30)throw new Error('Own signed S3 endpoint did not become ready.');
        await new Promise(resolve=>setTimeout(resolve,100));
    }
}
