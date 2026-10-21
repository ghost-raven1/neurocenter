import { expect, it, vi } from 'vitest';
import { LiveService } from '../../services/api-gateway/src/live/live.service';
it.each(['/api/agents','/api/agents/agent-one','/api/projects/project-one/agents/agent-one','/api/projects/project-one/agents/connect'])('Agent mutation %s инвалидирует каталог, проект и аудит',path=>{
    const live=new LiveService();const sections=vi.spyOn(live,'sections');live.mutation(path,'admin@test',undefined,'PATCH');expect(sections).toHaveBeenCalledOnce();expect(sections.mock.calls[0][0]).toEqual(expect.arrayContaining(['catalog','projects','audit','operations']));
});
