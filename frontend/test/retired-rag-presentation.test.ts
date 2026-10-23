import {describe,expect,it} from 'vitest';
import {retiredRagPage,retiredRagStatus} from '../src/features/RetiredRagDatabases/presentation';
import type {IRetiredRagDatabase} from '../src/features/RetiredRagDatabases/types';

const row=(id:string,deleted=false):IRetiredRagDatabase=>({id,projectId:`project-${id}`,projectName:`Проект ${id}`,deletedAt:'2026-10-23T10:00:00Z',origin:'project',
    retention:{revision:1,retainUntil:null,reason:'',automaticPurge:false},database:{databaseName:`nc_rag_${id}`,state:deleted?'purged':'retained',present:!deleted,bytes:1024},blockers:[],job:null});

describe('Retired RAG inventory stays bounded while records and truthful states are preserved',()=>{
    it('Shows at most five records per page and reaches every record without duplicates',()=>{
        const items=Array.from({length:21},(_,index)=>row(String(index)));
        const pages=[1,2,3,4,5].map(page=>retiredRagPage(items,'','all',page));
        expect(pages.map(page=>page.items.length)).toEqual([5,5,5,5,1]);
        expect(pages.flatMap(page=>page.items)).toEqual(items);expect(items).toHaveLength(21);
        expect(retiredRagPage(items,'','all',999).page).toBe(5);
        expect(retiredRagPage(items,'','all',-1).page).toBe(1);
    });
    it('Retained/deleted filters and case-insensitive search include technical identities on demand',()=>{
        const items=[row('alpha'),row('beta',true),{...row('gamma'),projectName:'Архив команды'}];
        expect(retiredRagPage(items,'','retained',1).items.map(item=>item.id)).toEqual(['alpha','gamma']);
        expect(retiredRagPage(items,'','deleted',1).items.map(item=>item.id)).toEqual(['beta']);
        expect(retiredRagPage(items,' АРХИВ ','all',1).items.map(item=>item.id)).toEqual(['gamma']);
        expect(retiredRagPage(items,'nc_rag_beta','all',1).items.map(item=>item.id)).toEqual(['beta']);
        expect(retiredRagPage(items,'nothing','all',4)).toMatchObject({items:[],page:1,total:0});
    });
    it('Missing physical data is not a confirmed deletion; a replacement database remains an anomaly',()=>{
        const missing={...row('missing'),database:{...row('missing').database!,present:false}};
        expect(retiredRagStatus(missing)).toMatchObject({purged:false,missing:true,label:'База отсутствует'});
        const replacement={...row('replacement',true),database:{...row('replacement',true).database!,present:true}};
        expect(retiredRagStatus(replacement)).toMatchObject({purged:false,anomaly:true,label:'Требует проверки'});
        expect(retiredRagPage([missing,replacement],'','retained',1).total).toBe(2);
    });
});
