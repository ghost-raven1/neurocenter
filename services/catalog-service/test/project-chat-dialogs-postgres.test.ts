import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool, type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';
import type {ModelsService} from '../src/models/models.service';
import type {ProjectChatInferenceService} from '../src/project-chat-inference/project-chat-inference.service';
import {ProjectChatService} from '../src/project-chat/project-chat.service';
import {PROJECT_CHAT_SCHEMA_SQL} from '../src/project-chat/project-chat.schema';
import {PROJECT_CHAT_DIALOGS_SCHEMA_SQL} from '../src/project-chat/project-chat-dialogs.schema';
import {DEFAULT_PROJECT_CHAT_ROOM, type ProjectChatMessageRow} from '../src/project-chat/project-chat.types';
import {deviceCompletionFixture,ownedDeviceTestAdminUrl} from './device-completion-postgres.fixture';
const flags=vi.hoisted(()=>({dialogs:true,project:true,group:true}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async(keys:string[])=>{if(keys.includes('project_chat_dialogs')&&!flags.dialogs||keys.includes('project_chat')&&!flags.project||keys.includes('group_chat')&&!flags.group)throw new ForbiddenException('Feature disabled');})}));
const adminUrl=process.env.PROJECT_CHAT_TEST_ADMIN_URL;
const a='creator@rooms.test', b='invited@rooms.test', outsider='outside@rooms.test', admin='admin@rooms.test', main='main@rooms.test', pin='a'.repeat(64), agent='agent-rooms-test';
const bounded=async<T>(promise:Promise<T>):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned dialogue barrier timed out')),5000);})]);}finally{if(timer)clearTimeout(timer);}};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
describe.skipIf(!adminUrl).sequential('Public and private dialogues — owned PostgreSQL',()=>{
    let f:Awaited<ReturnType<typeof deviceCompletionFixture>>,service:ProjectChatService,project:string;
    const calls:string[]=[], legacyProject='prj-legacy-rooms', legacyMessage=randomUUID(), token=randomUUID();
    let infer:(input:{source:ProjectChatMessageRow})=>Promise<{content:string}>;
    const req=(email=a,activeRole='Разработчик')=>({headers:{'x-neurocenter-internal':token,'x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole}))}} as Request);
    const mainReq=()=>req(main,'Главный админ');
    const create=(visibility='PRIVATE',members:string[]=[b],extra={})=>service.createRoom(req(),project,{requestKey:randomUUID(),title:'Private release '+randomUUID(),visibility,memberEmails:visibility==='PRIVATE'?members:[],...extra});
    const send=(roomId=DEFAULT_PROJECT_CHAT_ROOM,email=a,extra={})=>service.send(req(email),project,{requestKey:randomUUID(),prompt:'Question '+randomUUID(),targetAgentIds:[],...extra},roomId);
    async function configure(roomId:string){const detail=await service.read(req(admin,'Админ проекта'),project,undefined,roomId);await service.participants(req(admin,'Админ проекта'),project,{expectedRevision:detail.room.revision,agentIds:[agent],modelId:'model-rooms',expectedModelPin:pin},roomId);}
    beforeAll(async()=>{
        ownedDeviceTestAdminUrl(adminUrl!);f=await deviceCompletionFixture(adminUrl!);
        await f.pool.query(`CREATE TABLE projects(id text PRIMARY KEY,name text NOT NULL,state text NOT NULL DEFAULT 'ACTIVE');
            CREATE TABLE platform_users(email text PRIMARY KEY,enabled boolean NOT NULL DEFAULT true,is_main_admin boolean NOT NULL DEFAULT false,display_name text NOT NULL DEFAULT 'Person');
            CREATE TABLE project_members(project_id text REFERENCES projects(id) ON DELETE CASCADE,user_id text,principal_name text,display_name text,role text,PRIMARY KEY(project_id,principal_name));`);
        await f.pool.query(PROJECT_CHAT_SCHEMA_SQL);
        await f.pool.query('CREATE TABLE model_usage_calls(id uuid PRIMARY KEY)');
        await f.pool.query("INSERT INTO projects(id,name) VALUES($1,'Legacy')",[legacyProject]);
        await f.pool.query("INSERT INTO platform_users(email,is_main_admin) VALUES($1,false)",[a]);
        await f.pool.query("INSERT INTO project_members VALUES($1,$2,$2,'Creator','Разработчик')",[legacyProject,a]);
        await f.pool.query("INSERT INTO project_chat_rooms(project_id) VALUES($1)",[legacyProject]);
        await f.pool.query("INSERT INTO project_chat_messages(id,project_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,generation) VALUES($1,$2,'user','LEGACY PUBLIC HISTORY',$3,'Creator','Разработчик','done',$4,$5,$6)",[legacyMessage,legacyProject,a,randomUUID(),'a'.repeat(64),randomUUID()]);
        await f.pool.query(PROJECT_CHAT_DIALOGS_SCHEMA_SQL);
        for(const email of [b,outsider,admin,main])await f.pool.query('INSERT INTO platform_users(email,is_main_admin) VALUES($1,$2)',[email,email===main]);
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN',token);
    });
    beforeEach(async()=>{
        flags.dialogs=true;flags.project=true;flags.group=true;calls.length=0;project='prj-rooms-'+randomUUID();
        await f.pool.query('INSERT INTO projects(id,name) VALUES($1,$1)',[project]);
        for(const email of [a,b,outsider,admin])await f.pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',[project,email,email===admin?'Админ проекта':'Разработчик']);
        infer=async({source})=>({content:'Answer '+source.content});
        const actor=async(request:Request)=>{
            const input=JSON.parse(decodeURIComponent(String(request.headers['x-bridge-actor']))),account=(await f.pool.query('SELECT * FROM platform_users WHERE email=$1',[input.email])).rows[0];
            if(!account?.enabled)throw new ForbiddenException();
            const grants=(await f.pool.query('SELECT project_id,role FROM project_members WHERE principal_name=$1',[input.email])).rows;
            return{...input,claims:{email:input.email,userRoles:[...new Set(grants.map(row=>row.role)),...(account.is_main_admin?['Главный админ']:[])],projects:grants.map(row=>({projectId:row.project_id,projectName:row.project_id,role:row.role})),pluginIds:[],skillPaths:[]}};
        };
        service=new ProjectChatService({pool:f.pool,actor} as unknown as ModelsService,{roster:async()=>[],resolve:async()=>[{agentId:agent,name:'Agent',slug:'nc-rooms',modelId:'model-rooms',modelPin:pin,definition:{prompt:'Specialist'}}],assert:async()=>{},infer:async(input:{source:ProjectChatMessageRow})=>{calls.push(input.source.id);return infer(input);}} as unknown as ProjectChatInferenceService);
    });
    afterEach(async()=>{await service.onApplicationShutdown();});
    afterAll(async()=>{if(!f)return;const cleanup=await f.dispose();if(process.env.PROJECT_CHAT_DIALOGS_TEST_RECEIPT)await writeFile(process.env.PROJECT_CHAT_DIALOGS_TEST_RECEIPT,JSON.stringify(cleanup,null,2)+'\n',{flag:'wx'});expect(cleanup).toMatchObject({dropped:true,newDatabasesRemaining:[],originalDatabasesPreserved:true});vi.unstubAllEnvs();});
    it('upgrades the existing history into the public default room without changing its message identity',async()=>{
        const detail=await service.read(req(),legacyProject);expect(detail.room).toMatchObject({id:DEFAULT_PROJECT_CHAT_ROOM,visibility:'PUBLIC',title:'Общий чат'});expect(detail.messages[0]).toMatchObject({id:legacyMessage,content:'LEGACY PUBLIC HISTORY',roomId:DEFAULT_PROJECT_CHAT_ROOM});
    });
    it('lists public dialogues for the project and private titles only for creator or invited people',async()=>{
        const privateRoom=await create(),publicRoom=await create('PUBLIC');await send(privateRoom.id);
        for(const email of [a,b])expect((await service.rooms(req(email),project)).rooms.map(room=>room.id)).toContain(privateRoom.id);
        for(const request of [req(outsider),req(admin,'Админ проекта'),mainReq()]){const rooms=await service.rooms(request,project);expect(rooms.rooms.map(room=>room.id)).toContain(publicRoom.id);expect(JSON.stringify(rooms)).not.toContain(privateRoom.title);expect(rooms.rooms.map(room=>room.id)).not.toContain(privateRoom.id);}
    });
    it('a held authorized room-list transaction fences membership revocation until its safe snapshot commits',async()=>{
        const room=await create(),began=deferred(),release=deferred(),monitor=new Pool({connectionString:f.pool.options.connectionString,max:1});
        const original=service.repository.transaction.bind(service.repository);let pause=true;
        vi.spyOn(service.repository,'transaction').mockImplementation(action=>original(db=>action({query:async(sql:string,...values:unknown[])=>{const result=await (db.query as(...args:unknown[])=>Promise<unknown>)(sql,...values);if(pause&&sql.startsWith('SELECT r.* FROM project_chat_rooms')){pause=false;began.resolve();await release.promise;}return result;}} as unknown as PoolClient)));
        const listing=service.rooms(req(b),project);let writer:PoolClient|undefined,writing:Promise<unknown>|undefined;
        try{await bounded(began.promise);writer=await f.observer.connect();await writer.query('BEGIN');const pid=(await writer.query('SELECT pg_backend_pid() AS id')).rows[0].id;
            writing=(async()=>{await writer!.query('UPDATE project_chat_rooms SET revision=revision+1 WHERE project_id=$1 AND id=$2',[project,room.id]);await writer!.query('DELETE FROM project_chat_room_members WHERE project_id=$1 AND room_id=$2 AND email=$3',[project,room.id,b]);await writer!.query('COMMIT');})();
            await bounded((async()=>{for(;;){if((await monitor.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted',[pid])).rowCount)return;await new Promise(resolve=>setImmediate(resolve));}})());
            release.resolve();expect((await bounded(listing)).rooms.some(value=>value.id===room.id)).toBe(true);await bounded(writing);
            expect((await service.rooms(req(b),project)).rooms.some(value=>value.id===room.id)).toBe(false);
        }finally{release.resolve();await writing?.catch(()=>{});if(writer){await writer.query('ROLLBACK');writer.release();}await monitor.end();}
    });
    it('the displayed private audience includes its authorized main-admin creator without adding unrelated administrators',async()=>{
        const room=await service.createRoom(mainReq(),project,{requestKey:randomUUID(),title:'Explicit admin creator',visibility:'PRIVATE',memberEmails:[b]});
        const detail=await service.read(req(b),project,undefined,room.id);expect(detail.members.map(member=>member.email).sort()).toEqual([b,main].sort());expect(detail.members.find(member=>member.email===main)?.role).toBe('Главный админ');
        expect(detail.members.some(member=>member.email===admin)).toBe(false);
    });
    it('private direct read/history/send/retry/cancel/participants deny an uninvited main admin without content or profile calls',async()=>{
        const room=await create(),source=await send(room.id),request=mainReq();
        for(const action of [()=>service.read(request,project,undefined,room.id),()=>service.history(request,project,undefined,undefined,room.id),()=>service.send(request,project,{requestKey:randomUUID(),prompt:'No',targetAgentIds:[]},room.id),()=>service.retry(request,project,source.message.id,{requestKey:randomUUID()},room.id),()=>service.cancel(request,project,source.message.id,{},room.id),()=>service.participants(request,project,{expectedRevision:2,agentIds:[]},room.id)])await expect(action()).rejects.toHaveProperty('status',404);
        expect(calls).toEqual([]);
    });
    it('bounds history cursor, watched IDs and replies to the exact room even when the same user joins both',async()=>{
        const left=await create(),right=await create(),source=await send(left.id);
        expect((await service.read(req(),project,source.message.id,right.id)).messages).toEqual([]);
        await expect(service.history(req(),project,source.message.id,undefined,right.id)).rejects.toHaveProperty('status',404);
        await expect(send(right.id,a,{replyToId:source.message.id})).rejects.toHaveProperty('status',404);
        await expect(f.pool.query(`INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,author_email,author_name,author_role,reply_to_id,status,request_key,request_hash,generation)
            VALUES($1,$2,$3,'user','cross room',$4,'Creator','Разработчик',$5,'done',$6,$7,$8)`,[randomUUID(),project,right.id,a,source.message.id,randomUUID(),'a'.repeat(64),randomUUID()])).rejects.toHaveProperty('code','23503');
    });
    it('the same send request key is scoped by room and exact replay cannot redirect its receipt',async()=>{
        const left=await create(),right=await create(),body={requestKey:randomUUID(),prompt:'Same body',targetAgentIds:[]};
        const one=await service.send(req(),project,body,left.id),two=await service.send(req(),project,body,right.id);expect(one.message.id).not.toBe(two.message.id);expect((await service.send(req(),project,body,left.id)).message.id).toBe(one.message.id);
    });
    it('creation and send receipt replay survive flags OFF while fresh custom work is denied and the legacy chat remains usable',async()=>{
        const body={requestKey:randomUUID(),title:'Idempotent private',visibility:'PRIVATE',memberEmails:[b]},room=await create('PRIVATE',[b],body),message={requestKey:randomUUID(),prompt:'Accepted',targetAgentIds:[]};
        const first=await service.send(req(),project,message,room.id);flags.dialogs=false;
        expect((await service.createRoom(req(),project,body)).id).toBe(room.id);expect((await service.send(req(),project,message,room.id)).message.id).toBe(first.message.id);
        await expect(create()).rejects.toHaveProperty('status',403);await expect(send(room.id)).rejects.toHaveProperty('status',403);expect((await send()).message.status).toBe('done');expect((await service.read(req(b),project,undefined,room.id)).messages).toHaveLength(1);
    });
    it('group-chat OFF leaves new private human conversations usable while agent requests are denied',async()=>{
        flags.group=false;const room=await create();expect((await send(room.id)).message.status).toBe('done');
        flags.group=true;const current=await service.read(req(),project,undefined,room.id);await service.participants(req(),project,{expectedRevision:current.room.revision,agentIds:[agent],modelId:'model-rooms',expectedModelPin:pin},room.id);flags.group=false;
        await expect(send(room.id,a,{targetAgentIds:[agent]})).rejects.toHaveProperty('status',403);expect(calls).toEqual([]);
    });
    it('CAS removal remains available with flags OFF and immediately removes all private access',async()=>{
        const room=await create(),current=await service.read(req(),project,undefined,room.id);flags.dialogs=false;
        await service.updateRoom(req(),project,room.id,{expectedRevision:current.room.revision,title:room.title,memberEmails:[]});
        await expect(service.read(req(b),project,undefined,room.id)).rejects.toHaveProperty('status',404);
        await expect(service.updateRoom(req(),project,room.id,{expectedRevision:current.room.revision,title:room.title,memberEmails:[]})).rejects.toHaveProperty('status',409);
    });
    it('only fresh enabled project members can be newly invited and audience visibility is immutable',async()=>{
        await expect(create('PRIVATE',['foreign@rooms.test'])).rejects.toHaveProperty('status',400);const room=await create();
        await expect(f.pool.query("UPDATE project_chat_rooms SET visibility='PUBLIC' WHERE project_id=$1 AND id=$2",[project,room.id])).rejects.toThrow('immutable');
        await f.pool.query('DELETE FROM project_members WHERE project_id=$1 AND principal_name=$2',[project,b]);await expect(service.read(req(b),project,undefined,room.id)).rejects.toHaveProperty('status',403);
        await expect(service.updateRoom(req(),project,room.id,{expectedRevision:room.revision,title:room.title,memberEmails:[b,main]})).rejects.toHaveProperty('status',400);
    });
    it('agent configuration is per room and an uninvited project admin cannot configure it',async()=>{
        const left=await create('PRIVATE',[b,admin]),right=await create();await configure(left.id);
        expect((await service.read(req(),project,undefined,left.id)).room.agentIds).toEqual([agent]);expect((await service.read(req(),project,undefined,right.id)).room.agentIds).toEqual([]);
        await expect(service.participants(req(admin,'Админ проекта'),project,{expectedRevision:1,agentIds:[]},right.id)).rejects.toHaveProperty('status',404);
    });
    it('a developer creator configures assigned agents in their private room without inviting an administrator',async()=>{
        const room=await create(),detail=await service.read(req(),project,undefined,room.id);expect(detail.canConfigure).toBe(true);
        await service.participants(req(),project,{expectedRevision:detail.room.revision,agentIds:[agent],modelId:'model-rooms',expectedModelPin:pin},room.id);
        const accepted=await send(room.id,a,{targetAgentIds:[agent]});await service.runner.waitIdle();expect(calls).toEqual([accepted.message.id]);
        const current=await service.read(req(),project,undefined,room.id);expect(current.messages.some(message=>message.kind==='agent'&&message.status==='done')).toBe(true);
        await expect(service.participants(req(b),project,{expectedRevision:current.room.revision,agentIds:[]},room.id)).rejects.toHaveProperty('status',403);
    });
    it('private author revocation before execution starts spends no model call',async()=>{
        const room=await create('PRIVATE',[b,admin]);await configure(room.id);const schedule=vi.spyOn(service.runner,'schedule').mockImplementation(()=>{});await send(room.id,b,{targetAgentIds:[agent]});
        const current=await service.read(req(),project,undefined,room.id);await service.updateRoom(req(),project,room.id,{expectedRevision:current.room.revision,title:room.title,memberEmails:[admin]});
        schedule.mockRestore();service.runner.schedule(project);await service.runner.waitIdle();expect(calls).toEqual([]);
    });
    it('private membership removal while the provider is held prevents publication of its late answer',async()=>{
        const room=await create('PRIVATE',[b,admin]);await configure(room.id);const began=deferred(),release=deferred();infer=async()=>{began.resolve();await release.promise;return{content:'LATE PRIVATE OUTPUT'};};
        try{const accepted=await send(room.id,b,{targetAgentIds:[agent]});await bounded(began.promise);const current=await service.read(req(),project,undefined,room.id);
            await service.updateRoom(req(),project,room.id,{expectedRevision:current.room.revision,title:room.title,memberEmails:[admin]});release.resolve();await service.runner.waitIdle();
            const rows=(await f.observer.query('SELECT content,status FROM project_chat_messages WHERE source_message_id=$1',[accepted.message.id])).rows;expect(rows.every(row=>!row.content.includes('LATE PRIVATE OUTPUT'))).toBe(true);
        }finally{release.resolve();}
    });
    it('multiple rooms share the existing author queue cap; human-only posts remain usable',async()=>{
        const left=await create('PRIVATE',[admin]),right=await create('PRIVATE',[admin]);await configure(left.id);await configure(right.id);const schedule=vi.spyOn(service.runner,'schedule').mockImplementation(()=>{});
        try{for(let index=0;index<20;index++)await send(index%2?left.id:right.id,a,{targetAgentIds:[agent]});await expect(send(right.id,a,{targetAgentIds:[agent]})).rejects.toHaveProperty('status',409);expect((await send(right.id)).message.status).toBe('done');}finally{schedule.mockRestore();}
    });
});
