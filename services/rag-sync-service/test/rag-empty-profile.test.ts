import {describe,expect,it,vi} from 'vitest';
import {bindIndexProfile} from '../src/rag/rag-index-state';
import {generation} from './rag-write.fixture';
const profile={provider:'openai',model:'old-model',dimension:3};
const replacement={...profile,model:'new-model'};
describe('Профиль одного поколения неизменяем даже для пустого индекса',()=>{
    it.each([null,replacement,{...profile,dimension:5},{...profile,provider:'ollama'}])('Другой профиль не перепривязывает существующее поколение: %j',async indexProfile=>{
        const db={query:vi.fn(async()=>({rows:[{index_profile:profile}]}))};
        await expect(bindIndexProfile(db as never,'project',generation(),{indexProfile})).rejects.toMatchObject({status:409});
        expect(db.query.mock.calls.every(([sql])=>String(sql).startsWith('SELECT'))).toBe(true);
    });
    it('Первый профиль связывает только ранее непроверенное поколение',async()=>{
        const db={query:vi.fn(async()=>({rows:[]}))};await bindIndexProfile(db as never,'project',generation(),{indexProfile:profile});
        expect(db.query.mock.calls.filter(([sql])=>String(sql).startsWith('INSERT'))).toHaveLength(1);
    });
    it('Точный повтор профиля ничего не переписывает',async()=>{
        const db={query:vi.fn(async()=>({rows:[{index_profile:profile}]}))};await bindIndexProfile(db as never,'project',generation(),{indexProfile:profile});
        expect(db.query).toHaveBeenCalledOnce();
    });
});
