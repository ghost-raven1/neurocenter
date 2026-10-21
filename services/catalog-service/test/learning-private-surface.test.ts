import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {LearningService} from '../src/learning/learning.service';
describe('Project learning browser boundary',()=>{
    it('keeps unapproved records and decisions outside the generic device HTTP surface',async()=>{
        const actor=vi.fn(),service=new LearningService({actor} as never),req={headers:{authorization:'Bearer device-token'}} as never,id=randomUUID();
        try{
            const reads=[service.overview(req,'prj-learning'),service.context(req,'prj-learning'),service.page(req,'prj-learning','experiences'),
                service.detail(req,'prj-learning','hypotheses',id),service.checks(req,'prj-learning',id),service.checkDetail(req,'prj-learning',id,id),
                service.history(req,'prj-learning'),service.request(req,'prj-learning',id)];
            for(const read of reads)await expect(read).rejects.toMatchObject({status:403});
            expect(actor).not.toHaveBeenCalled();
        }finally{await service.onApplicationShutdown();}
    });
});
