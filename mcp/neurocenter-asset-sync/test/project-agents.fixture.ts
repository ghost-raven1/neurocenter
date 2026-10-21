import fs from 'node:fs/promises';
import path from 'node:path';
import {vi} from 'vitest';
import {createProjectAgentsPayload,compileProjectAgents,type ProjectAgent,type ProjectAgentsPayload} from '../src/features/project-agents/contract.js';
/** Own HOME prevents the native/config fixtures from observing a developer's installed providers. */
export async function isolateAgentHome(directory:string){
    const home=path.join(directory,'agent-home');await fs.mkdir(path.join(home,'.config/opencode'),{recursive:true});
    vi.stubEnv('HOME',home);vi.stubEnv('XDG_CONFIG_HOME',path.join(home,'.config'));vi.stubEnv('XDG_DATA_HOME',path.join(home,'.local/share'));
    for(const key of ['OPENCODE_CONFIG','OPENCODE_CONFIG_DIR','OPENCODE_CONFIG_CONTENT'])vi.stubEnv(key,'');
    await fs.writeFile(path.join(home,'.config/opencode/opencode.json'),JSON.stringify({provider:{provider:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://provider.example.test/v1'},models:{model:{}}}}}));return home;
}
/** Tests approve the same deterministic metadata as the HTTP compiler fixture, without a provider call. */
export function preparedAgentsPayload(input:Omit<ProjectAgentsPayload,'modelRequirements'|'manifestSha256'|'compilation'>):ProjectAgentsPayload{
    const modelRequirements=input.agents.filter(agent=>agent.enabled&&agent.model).map(agent=>({kind:'native' as const,agentId:agent.id,selector:agent.model!}));
    const payload=createProjectAgentsPayload({...input,modelRequirements});
    payload.compilation=compileProjectAgents(payload,modelRequirements.map(requirement=>{const [provider,...model]=requirement.selector.split('/');return{agentId:requirement.agentId,provider:provider!,configKey:model.join('/'),model:model.join('/'),runtime:'remote-openai',baseUrl:'https://provider.example.test/v1',options:{},capability:'chat'};}));return payload;
}
