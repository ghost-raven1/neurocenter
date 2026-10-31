import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {publicationNameConflict} from '../src/package-build/publication-target';
import {PackageBuildService} from '../src/package-build/package-build.service';

const actor={email:'admin@example.test',activeRole:'Главный админ' as const};
describe('Exact build name conflict discovery does not authorize publication',()=>{
    it.each([null,'2026-10-30'])('Includes archived=%s and keeps kind for the UI decision',async archived=>{
        const query=vi.fn().mockResolvedValue({rows:[{id:'native-tool',kind:'plugin',name:'Tool',archived_at:archived}]});
        expect(await publicationNameConflict({query} as unknown as Pool,' tool ')).toEqual({catalogId:'native-tool',kind:'plugin',name:'Tool',archived:!!archived});
        expect(query).toHaveBeenCalledExactlyOnceWith('SELECT id,kind,name,archived_at FROM ai_plugins WHERE lower(name)=lower($1)',['tool']);
    });
    it('No exact match returns no target',async()=>{
        expect(await publicationNameConflict({query:vi.fn().mockResolvedValue({rows:[]})} as unknown as Pool,'Other')).toBeNull();
    });
    it.each([null,[],{},'', ' ', 'a'.repeat(241), 'line\nname'])('Rejects invalid lookup %j before SQL',async name=>{
        const query=vi.fn();await expect(publicationNameConflict({query} as unknown as Pool,name)).rejects.toMatchObject({status:400});expect(query).not.toHaveBeenCalled();
    });
    it('Revocation while reading prevents return of a candidate',async()=>{
        const requireMain=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
        const query=vi.fn().mockResolvedValue({rows:[]});
        const service=Object.assign(Object.create(PackageBuildService.prototype),{pool:{query},requireMain}) as PackageBuildService;
        await expect(service.publicationConflict(actor,'Tool')).rejects.toThrow('revoked');expect(requireMain).toHaveBeenCalledTimes(2);
    });
    it('Missing administrator rights prevents the lookup itself',async()=>{
        const query=vi.fn(),requireMain=vi.fn().mockRejectedValue(new Error('forbidden'));
        const service=Object.assign(Object.create(PackageBuildService.prototype),{pool:{query},requireMain}) as PackageBuildService;
        await expect(service.publicationConflict(actor,'Tool')).rejects.toThrow('forbidden');expect(query).not.toHaveBeenCalled();
    });
});
