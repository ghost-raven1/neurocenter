import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {configureBuildPublicationTransaction,publicationDeadlineMessage,PUBLICATION_DEADLINE_MESSAGE} from '../src/package-build/publication-deadline';

describe('Publication transaction deadlines preserve independently stricter upstream settings',()=>{
    it.each([
        ['0','0',['5000ms','30000ms']],
        ['60000','90000',['5000ms','30000ms']],
        ['100','200',['100ms','200ms']],
        ['100','0',['100ms','30000ms']],
        ['0','200',['5000ms','200ms']],
        ['5000','30000',['5000ms','30000ms']],
    ])('Clamps lock=%s and statement=%s without changing transaction ownership',async(lock,statement,expected)=>{
        const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[{lock_ms:lock,statement_ms:statement}]}));
        await configureBuildPublicationTransaction({query} as unknown as PoolClient);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[1]).toEqual(["SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",expected]);
        expect(query.mock.calls.some(call=>['BEGIN','COMMIT','ROLLBACK'].includes(String(call[0])))).toBe(false);
    });
    it.each([1,2])('A settings query failure at boundary %s remains the caller’s primary error',async(boundary)=>{
        const primary=Error('Owned settings ACK lost');let calls=0;
        const query=vi.fn(async()=>{if(++calls===boundary)throw primary;return {rows:[{lock_ms:'0',statement_ms:'0'}]};});
        await expect(configureBuildPublicationTransaction({query} as unknown as PoolClient)).rejects.toBe(primary);
        expect(query).toHaveBeenCalledTimes(boundary);
    });
    it.each(['55P03','57014'])('Formats SQL %s without exposing its raw message or replacing its identity',code=>{
        const error=Object.assign(Error('secret fixture SQL detail'),{code});
        expect(publicationDeadlineMessage(error)).toBe(PUBLICATION_DEADLINE_MESSAGE);
        expect(error.message).toBe('secret fixture SQL detail');
    });
    it.each([Error('COMMIT ACK lost'),{code:'ECONNRESET'},null,undefined])('An unknown commit/transport outcome is not labeled a timeout',error=>{
        expect(publicationDeadlineMessage(error)).toBeUndefined();
    });
});
