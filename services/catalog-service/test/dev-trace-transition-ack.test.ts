import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {PackageBuildRepository} from '../src/package-build/package-build.repository';
import {ChatRepository} from '../src/model-chat/chat.repository';

describe('Trace terminal acknowledgments describe only committed authoritative transitions',()=>{
    it.each([0,1])('build cancellation acknowledges rowCount=%s without another business query',async rowCount=>{
        const row={id:randomUUID(),state:'CANCELLED',percent:0},query=vi.fn(async(sql:string)=>{
            if(sql.includes('EXTRACT(EPOCH'))return {rows:[{lock_ms:'0',statement_ms:'0'}],rowCount:1};
            if(sql.startsWith('UPDATE tool_build_jobs'))return {rows:rowCount?[row]:[],rowCount};
            return {rows:[],rowCount:0};
        }),release=vi.fn(),repository=new PackageBuildRepository({connect:async()=>({query,release}) as unknown as PoolClient} as unknown as Pool);
        expect(await repository.completeCancellation(row.id)).toBe(rowCount===1);
        expect(query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE tool_build_jobs'))).toHaveLength(1);
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);expect(release).toHaveBeenCalledOnce();
    });
    it.each([0,1])('chat failure acknowledges rowCount=%s after its existing transaction',async rowCount=>{
        const row={id:randomUUID(),revision:1},query=vi.fn(async(sql:string)=>{
            if(sql.startsWith('SELECT * FROM model_chat_conversations'))return {rows:[row],rowCount:1};
            if(sql.startsWith('UPDATE model_chat_turns SET status='))return {rows:[],rowCount};
            if(sql.startsWith('UPDATE model_chat_conversations'))return {rows:[{...row,revision:2}],rowCount:1};
            return {rows:[],rowCount:0};
        }),release=vi.fn(),repository=new ChatRepository({connect:async()=>({query,release}) as unknown as PoolClient} as unknown as Pool);
        expect(await repository.fail(row.id,randomUUID(),randomUUID(),'failed','Private failure')).toBe(rowCount===1);
        expect(query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE model_chat_turns SET status='))).toHaveLength(1);
        expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);expect(release).toHaveBeenCalledOnce();
    });
    it('a removed conversation acknowledges no failure transition',async()=>{
        const query=vi.fn(async()=>({rows:[],rowCount:0})),release=vi.fn();
        const repository=new ChatRepository({connect:async()=>({query,release}) as unknown as PoolClient} as unknown as Pool);
        expect(await repository.fail(randomUUID(),randomUUID(),randomUUID(),'cancelled','Private cancellation')).toBe(false);
        expect(query.mock.calls).toHaveLength(3);expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
    });
});
