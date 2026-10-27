import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {workspaceFixture} from './bridge-fixture.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {writeState} from '../src/bridge/state.js';
import {AGENT_METHOD_WORKFLOW_PROTOCOL,type AgentMethodWorkflowPayload} from '../src/features/agent-method-workflow/contract.js';
export async function methodFixture(){
 const fixture=await workspaceFixture(),deviceId=randomUUID();
 await writeState('credentials',{token:'fixture-token',deviceId,email:'method@example.test'});
 await promisify(execFile)('git',['init','--quiet'],{cwd:fixture.root});
 await fs.writeFile(path.join(fixture.root,'app.js'),'existing user draft\n');
 await fs.writeFile(path.join(fixture.root,'unrelated.txt'),'user work must survive\n');
 await fs.writeFile(path.join(fixture.root,'runtime.cjs'),`const fs=require('node:fs');const count=fs.existsSync('dispatch-count')?Number(fs.readFileSync('dispatch-count','utf8')):0;fs.writeFileSync('dispatch-count',String(count+1));fs.writeFileSync('app.js','implemented fixture\\n');console.log('PRIVATE_OUTPUT_FAKE_TOKEN');`);
 await fs.writeFile(path.join(fixture.root,'check.cjs'),`const fs=require('node:fs');if(fs.readFileSync('app.js','utf8')!=='implemented fixture\\n')process.exit(7);`);
 const payload:AgentMethodWorkflowPayload={protocol:AGENT_METHOD_WORKFLOW_PROTOCOL,workflowId:randomUUID(),requestId:randomUUID(),projectId:'test-project',bindingId:await projectBindingId('test-project'),instanceId:await projectInstanceId('test-project'),
  method:'openspec',methodVersion:'1.15.0',stage:'full-cycle',instruction:'Implement the owned QA fixture only.',deadlineAt:new Date(Date.now()+120000).toISOString(),runtime:'opencode',checks:[{command:'node',args:['check.cjs']}]};
 return {...fixture,deviceId,payload,job:{id:randomUUID(),lease:randomUUID(),project_id:'test-project',payload},prepare:async()=>({command:process.execPath,args:['runtime.cjs']})};
}
