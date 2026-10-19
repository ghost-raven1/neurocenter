import {describe,expect,it,vi} from 'vitest';
import {bindIndexProfile} from '../src/rag/rag-index-state';

const profile={provider:'ollama',model:'old-model',dimension:3};
const replacement={...profile,model:'new-model'};
const write={indexProfile:replacement,snapshot:{hash:'a'.repeat(64),rowCount:2,complete:false}};
const database=(hasRows:boolean)=>({query:vi.fn(async(sql:string)=>{
    if(sql.includes('SELECT index_profile')){return {rows:[{index_profile:profile}]};}
    if(sql.includes('SELECT EXISTS')){return {rows:[{has_rows:hasRows}]};}
    return {rows:[]};
})});

describe('Первая непустая порция меняет только пустой серверный профиль',()=>{
    it('Первые проверенные строки могут заменить закреплённую модель без сброса в NULL',async()=>{
        const db=database(false);
        await bindIndexProfile(db as never,'project',write,1);
        expect(db.query.mock.calls.some(([sql])=>sql.includes('SELECT EXISTS'))).toBe(true);
        const changes=db.query.mock.calls.filter(([sql])=>!sql.startsWith('SELECT'));
        expect(changes).toHaveLength(1);
        expect(changes[0][0]).toContain('index_profile=EXCLUDED.index_profile');
    });
    it('Хотя бы одна существующая строка запрещает смену профиля',async()=>{
        const db=database(true);
        await expect(bindIndexProfile(db as never,'project',write,1)).rejects.toMatchObject({status:409});
        expect(db.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
    });
    it.each([
        {write,count:0},
        {write:{...write,snapshot:{...write.snapshot,rowCount:0}},count:1},
        {write:{...write,snapshot:{...write.snapshot,complete:true}},count:0},
        {write:{indexProfile:replacement},count:1},
        {write:{indexProfile:null},count:1},
    ])('Пустая, legacy или seal-only порция не перепривязывает индекс: %j',async value=>{
        const db=database(false);
        await expect(bindIndexProfile(db as never,'project',value.write,value.count)).rejects.toMatchObject({status:409});
        expect(db.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
    });
});
