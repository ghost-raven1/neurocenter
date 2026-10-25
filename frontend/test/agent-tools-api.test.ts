import {beforeEach,expect,it,vi} from 'vitest';
import api from '../src/core/api/base';
import {agentToolsApi} from '../src/features/AgentTools/api';
import {modelChatApi} from '../src/features/ModelChat/api';
import {projectChatApi} from '../src/features/ProjectChat/api';
import {detail,model} from './model-chat-fixtures';
import type {AgentToolGrant} from '../src/features/AgentTools/types';
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(),post: vi.fn()}}));
beforeEach(() => {vi.clearAllMocks();vi.mocked(api.post).mockResolvedValue({data: detail()});vi.mocked(api.get).mockResolvedValue({data: {steps: []}});});
it('sends the same explicit pinned grant through personal/group and team owners without rewriting a replay key', async () => {
    const grant: AgentToolGrant = Object.freeze({protocol: 'json-actions-v1',rag: true,systemRoles: true,publicChats: Object.freeze({modelId: 'embedding-one',expectedModelPin: 'a'.repeat(64),consent: true})});
    const signal = new AbortController().signal;
    await modelChatApi.send(detail(),model,'same-request','Question',[],signal,['agent-one'],undefined,grant);
    expect(api.post).toHaveBeenLastCalledWith('/api/model-chats/chat-1/turns',expect.objectContaining({requestId: 'same-request',agentTools: grant,targetAgentIds: ['agent-one']}),expect.objectContaining({signal}));
    expect(vi.mocked(api.post).mock.calls[0][1]).not.toHaveProperty('research');
    const intent = Object.freeze({requestKey: 'same-request',prompt: 'Question',targetAgentIds: ['agent-one'],agentTools: grant});
    await projectChatApi.send('project-one',intent,signal);await projectChatApi.send('project-one',intent,signal);
    expect(vi.mocked(api.post).mock.calls.slice(1).map(call => call[1])).toEqual([intent,intent]);
});
it('capability/history reads are scoped and abortable and never use POST', async () => {
    const signal = new AbortController().signal;
    await agentToolsApi.capabilities('project-one',signal);expect(api.get).toHaveBeenLastCalledWith('/api/agent-tools/capabilities',{params: {projectId: 'project-one'},signal});
    await agentToolsApi.steps('project-one','turn-one',signal);expect(api.get).toHaveBeenLastCalledWith('/api/agent-tools/steps',{params: {projectId: 'project-one',turnId: 'turn-one'},signal});
    await agentToolsApi.step('step-one',signal);expect(api.get).toHaveBeenLastCalledWith('/api/agent-tools/steps/step-one',{signal});expect(api.post).not.toHaveBeenCalled();
});
