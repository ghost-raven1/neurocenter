import {beforeEach, describe, expect, it, vi} from 'vitest';
import api from '../src/core/api/base';
import {projectChatApi} from '../src/features/ProjectChat/api';
import {projectRoom} from './project-chat-fixtures';

vi.mock('../src/core/api/base', () => ({default: {get: vi.fn()}}));
beforeEach(() => {vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue({data: projectRoom()});});
describe('Project chat read contract', () => {
    it('First read omits watch, a later read serializes explicit IDs into the bounded server query', async () => {
        const signal = new AbortController().signal, ids = ['c9242f5e-90c7-4415-9940-43b3cead5ec2', '931ff792-2cd1-4791-bddd-c0c779fd5585'];
        await projectChatApi.read('prj-one', signal); expect(api.get).toHaveBeenLastCalledWith('/api/projects/prj-one/team-chat', {signal});
        await projectChatApi.read('prj-one', signal, ids); expect(api.get).toHaveBeenLastCalledWith('/api/projects/prj-one/team-chat', {signal, params: {watch: ids.join(',')}});
        expect(api.get).toHaveBeenCalledTimes(2);
    });
});
