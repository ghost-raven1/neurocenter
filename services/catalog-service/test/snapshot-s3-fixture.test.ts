import {afterEach,describe,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {snapshotS3FixtureAdmin,snapshotS3FixtureConfiguration,snapshotS3FixturePreflight} from './snapshot-s3.fixture';

const servers:Server[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));expect(server.listening).toBe(false);}});

const fixture={CHAT_S3_ENDPOINT:'http://127.0.0.1:59617',CHAT_S3_REGION:'us-east-1',CHAT_S3_ACCESS_KEY:'synthetic-access',CHAT_S3_SECRET_KEY:'synthetic-secret',CHAT_S3_PROJECT_BUCKET:'qa-project',CHAT_S3_PERSONAL_BUCKET:'qa-personal'};
describe('Snapshot S3 fixture owner boundary',()=>{
    it.each([59617,59627,29001])('accepts the explicitly owned loopback port%s without a session-specific assumption',port=>{
        expect(snapshotS3FixtureConfiguration({...fixture,CHAT_S3_ENDPOINT:'http://127.0.0.1:'+port})).toEqual({endpoint:'http://127.0.0.1:'+port,port,region:'us-east-1',accessKey:'synthetic-access',secretKey:'synthetic-secret'});
    });
    it.each(['http://127.0.0.1:0','http://127.0.0.1:19010','http://127.0.0.1:19011','http://127.0.0.1','https://127.0.0.1:59627','http://localhost:59627','http://[::1]:59627','http://remote.invalid:59627','http://private:secret@127.0.0.1:59627','http://127.0.0.1:59627/snapshots','http://127.0.0.1:59627?query=1','http://127.0.0.1:59627#fragment','not-a-url'])('refuses unowned or ambiguous endpoint %s before any I/O',endpoint=>{
        let failure:unknown;try{snapshotS3FixtureConfiguration({...fixture,CHAT_S3_ENDPOINT:endpoint});}catch(error){failure=error;}
        expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain('private:secret');
    });
    it.each(['CHAT_S3_REGION','CHAT_S3_ACCESS_KEY','CHAT_S3_SECRET_KEY','CHAT_S3_PROJECT_BUCKET','CHAT_S3_PERSONAL_BUCKET'])('requires the explicit integration field %s',field=>{
        for(const value of [undefined,null,'','   ',123])expect(()=>snapshotS3FixtureConfiguration({...fixture,[field]:value})).toThrow('Incomplete explicit');
    });
    it.each([null,undefined,[],{},123].map(value=>({value})))('unknown configuration $value does not acquire any infrastructure defaults',({value})=>expect(()=>snapshotS3FixtureConfiguration(value)).toThrow());
    it('requires distinct input bucket declarations even though actual cases create their own random buckets',()=>expect(()=>snapshotS3FixtureConfiguration({...fixture,CHAT_S3_PERSONAL_BUCKET:fixture.CHAT_S3_PROJECT_BUCKET})).toThrow('distinct private'));
    it.each(['postgresql://qa:synthetic@127.0.0.1:59616/postgres?port=5432','postgresql://qa:synthetic@127.0.0.1:59616/postgres?host=remote.invalid','postgresql://qa:synthetic@127.0.0.1:59616/application'])('rejects an admin URL before a pool or any I/O can use hidden connection settings: %s',value=>{
        expect(()=>snapshotS3FixtureAdmin(value)).toThrow();
    });
    it('keeps an explicitly owned admin URL exact rather than rewriting its database',()=>{
        const value='postgresql://qa:synthetic@127.0.0.1:59616/postgres';expect(snapshotS3FixtureAdmin(value).href).toBe(value);
    });
    it('accepts a Ceph-compatible signed S3 HEAD without a vendor health URL or bucket mutation',async()=>{
        const requests:Array<{method:string|undefined;path:string|undefined;signed:boolean}>=[];
        const server=createServer((request,response)=>{
            const signed=!!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ');requests.push({method:request.method,path:request.url,signed});
            response.writeHead(request.method==='HEAD'&&signed?404:403);response.end();
        });
        servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        const address=server.address();if(!address||typeof address==='string')throw Error('Missing own HTTP address');
        await expect(snapshotS3FixturePreflight({...fixture,CHAT_S3_ENDPOINT:'http://127.0.0.1:'+address.port})).resolves.toBeUndefined();
        expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({method:'HEAD',signed:true});expect(requests[0].path).toMatch(/^\/snapshot-readiness-[a-f0-9]{32}$/);
    },6000);
    it('refuses an endpoint that denies the signed identity without creating a bucket or leaking credentials',async()=>{
        const requests:Array<{method:string|undefined;path:string|undefined;signed:boolean}>=[];
        const server=createServer((request,response)=>{requests.push({method:request.method,path:request.url,signed:!!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')});response.writeHead(403);response.end();});
        servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
        const address=server.address();if(!address||typeof address==='string')throw Error('Missing own HTTP address');
        let failure:unknown;try{await snapshotS3FixturePreflight({...fixture,CHAT_S3_ENDPOINT:'http://127.0.0.1:'+address.port});}catch(error){failure=error;}
        expect(failure).toBeInstanceOf(Error);expect(String(failure)).toContain('Own signed S3 endpoint');expect(String(failure)).not.toContain(fixture.CHAT_S3_SECRET_KEY);
        expect(requests).toHaveLength(31);expect(requests.every(row=>row.method==='HEAD'&&row.signed&&/^\/snapshot-readiness-[a-f0-9]{32}$/.test(row.path||''))).toBe(true);
        expect(new Set(requests.map(row=>row.path)).size).toBe(1);
    },6000);
});
