import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {ChatRepository} from '../src/model-chat/chat.repository';
import {chatRollbackFixture,chatFaultPool,connection,type ChatOwner} from './chat-rollback-postgres.fixture';

const actor='owner@chat-rollback.test',pin='a'.repeat(64);
describe.skipIf(connection===undefined).sequential('Chat repository actual transaction ownership',()=>{
    let f:Awaited<ReturnType<typeof chatRollbackFixture>>;
    beforeEach(async()=>{f=undefined!;f=await chatRollbackFixture();});
    afterEach(async()=>{await f?.close();});
    async function action(owner:ChatOwner,repository:ChatRepository,mode:'reject'|'constraint'|'success'){
        const primary=new ForbiddenException('Own actor access was revoked after the mutation');
        let admission=0;
        if(owner==='create')return{primary,run:()=>repository.create(actor,'owned-model',null,pin,mode==='constraint'?'':'New conversation',async()=>{if(++admission===2&&mode==='reject')throw primary;})};
        const saved=await new ChatRepository(f.pool).create(actor,'owned-model',null,pin,'Original conversation',async()=>{});
        return{primary,run:()=>repository.owned(actor,saved.id,async()=>{},async db=>{
            await db.query('UPDATE model_chat_conversations SET title=$2 WHERE id=$1',[saved.id,mode==='constraint'?'':'Updated conversation']);
            if(mode==='reject')throw primary;return saved.id;
        })};
    }
    async function observed(){return(await f.observer.query('SELECT * FROM model_chat_conversations WHERE owner_email=$1 ORDER BY id',[actor])).rows;}
    async function unrelatedCommit(){
        const client=await f.pool.connect();
        try{const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await client.query('SELECT 1 AS unrelated_borrower_read');await client.query('COMMIT');return pid;}
        finally{client.release();}
    }

    it.each(['create','owned'] as const)('%s never commits a rejected mutation through the next borrower after undispatched ROLLBACK',async owner=>{
        const fault=chatFaultPool(f.pool,'none','not-dispatched'),a=await action(owner,new ChatRepository(fault.pool),'reject'),before=await observed();
        const error=await a.run().catch(error=>error);
        expect(await observed()).toEqual(before);
        const nextPid=await unrelatedCommit();
        expect(await observed()).toEqual(before);
        expect(error).toBe(a.primary);expect(fault.releaseError()).toBe(true);expect(nextPid).not.toBe(fault.pid());
        expect(fault.events.some(event=>event.sql==='ROLLBACK'&&!event.executed)).toBe(true);
        expect(fault.events.some(event=>event.executed&&event.sql.startsWith(owner==='create'?'INSERT INTO model_chat_conversations':'UPDATE model_chat_conversations SET title='))).toBe(true);
    });

    it.each(['create','owned'] as const)('%s preserves the primary error and discards an actually rolled back session when its ACK is lost',async owner=>{
        const fault=chatFaultPool(f.pool,'none','ack-lost'),a=await action(owner,new ChatRepository(fault.pool),'reject'),before=await observed();
        const error=await a.run().catch(error=>error),nextPid=await unrelatedCommit();
        expect(await observed()).toEqual(before);expect(error).toBe(a.primary);
        expect(fault.events.some(event=>event.sql==='ROLLBACK'&&event.executed)).toBe(true);
        expect(fault.releaseError()).toBe(true);expect(nextPid).not.toBe(fault.pid());
    });

    it.each(['create','owned'] as const)('%s discards an unknown BEGIN session before any conversation write',async owner=>{
        const fault=chatFaultPool(f.pool,'begin-ack','not-dispatched'),a=await action(owner,new ChatRepository(fault.pool),'success'),before=await observed();
        const error=await a.run().catch(error=>error),nextPid=await unrelatedCommit();
        expect(await observed()).toEqual(before);expect(error).toBe(fault.failure);
        expect(fault.events.filter(event=>event.executed).map(event=>event.sql)).toEqual(['BEGIN']);
        expect(fault.releaseError()).toBe(true);expect(nextPid).not.toBe(fault.pid());
    });

    it.each(['create','owned'] as const)('%s preserves real PostgreSQL constraint failure and reuses a healthy rolled back session',async owner=>{
        const fault=chatFaultPool(f.pool,'none','normal'),a=await action(owner,new ChatRepository(fault.pool),'constraint'),before=await observed();
        const error=await a.run().catch(error=>error);
        expect(error).toMatchObject({code:'23514',constraint:'model_chat_conversations_title_check'});expect(error).toBe(fault.queryFailure());
        expect(await unrelatedCommit()).toBe(fault.pid());expect(fault.releaseError()).toBe(false);expect(await observed()).toEqual(before);
    });

    it.each(['create','owned'] as const)('%s retains exactly committed state after a lost COMMIT ACK and an unrelated borrower COMMIT',async owner=>{
        const fault=chatFaultPool(f.pool,'commit-ack','normal'),a=await action(owner,new ChatRepository(fault.pool),'success');
        const error=await a.run().catch(error=>error),committed=await observed();
        expect(error).toBe(fault.failure);expect(committed).toHaveLength(1);expect(committed[0].title).toBe(owner==='create'?'New conversation':'Updated conversation');
        expect(await unrelatedCommit()).toBe(fault.pid());expect(fault.releaseError()).toBe(false);expect(await observed()).toEqual(committed);
    });

    it.each(['create','owned'] as const)('%s commits normally and leaves its client reusable',async owner=>{
        const fault=chatFaultPool(f.pool,'none','normal'),a=await action(owner,new ChatRepository(fault.pool),'success');
        await a.run();const committed=await observed();
        expect(committed).toHaveLength(1);expect(committed[0].title).toBe(owner==='create'?'New conversation':'Updated conversation');
        expect(fault.events.filter(event=>event.sql==='COMMIT'&&event.executed)).toHaveLength(1);
        expect(await unrelatedCommit()).toBe(fault.pid());expect(fault.releaseError()).toBe(false);expect(await observed()).toEqual(committed);
    });
});
