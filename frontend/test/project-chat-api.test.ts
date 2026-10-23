import {beforeEach, describe, expect, it, vi} from 'vitest';
import api from '../src/core/api/base';
import {projectChatApi} from '../src/features/ProjectChat/api';
import {projectRoom} from './project-chat-fixtures';

vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(),post:vi.fn(),put:vi.fn()}}));
beforeEach(() => {vi.clearAllMocks();vi.mocked(api.post).mockResolvedValue({data:{}});vi.mocked(api.put).mockResolvedValue({data:{}}); vi.mocked(api.get).mockResolvedValue({data: projectRoom()});});
describe('Project chat read contract', () => {
    it('named room identity scopes message, history, membership and recovery routes',async()=>{
        const signal=new AbortController().signal,room='115af965-9952-402f-8811-20ae55f47991',base='/api/projects/prj-one/team-chat/rooms/'+room;
        await projectChatApi.read('prj-one',signal,undefined,room);expect(api.get).toHaveBeenLastCalledWith(base,{signal});
        await projectChatApi.history('prj-one','cursor',signal,room);expect(api.get).toHaveBeenLastCalledWith(base+'/history',{signal,params:{before:'cursor',limit:50}});
        await projectChatApi.send('prj-one',{requestKey:'key',prompt:'Question'},signal,room);expect(api.post).toHaveBeenLastCalledWith(base+'/messages',expect.anything(),expect.objectContaining({signal}));
        await projectChatApi.cancel('prj-one','message',signal,room);expect(api.post).toHaveBeenLastCalledWith(base+'/messages/message/cancel',{},expect.objectContaining({signal}));
    });
    it('First read omits watch, a later read serializes explicit IDs into the bounded server query', async () => {
        const signal = new AbortController().signal, ids = ['c9242f5e-90c7-4415-9940-43b3cead5ec2', '931ff792-2cd1-4791-bddd-c0c779fd5585'];
        await projectChatApi.read('prj-one', signal); expect(api.get).toHaveBeenLastCalledWith('/api/projects/prj-one/team-chat', {signal});
        await projectChatApi.read('prj-one', signal, ids); expect(api.get).toHaveBeenLastCalledWith('/api/projects/prj-one/team-chat', {signal, params: {watch: ids.join(',')}});
        expect(api.get).toHaveBeenCalledTimes(2);
    });
});
