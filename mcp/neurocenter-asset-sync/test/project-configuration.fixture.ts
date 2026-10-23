import {randomUUID} from 'node:crypto';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {configurationContext} from '../src/features/project-configuration/context.js';
import {openProjectConfiguration} from '../src/features/project-configuration/index.js';
import {ConfigurationEditor} from '../src/features/project-configuration/engine.js';
export async function configurationFixture(){const f=await providerFixture(),{deviceId,projectId,bindingId,instanceId}=f.descriptor;
    const descriptor={schemaVersion:1 as const,deviceId,projectId,bindingId,instanceId,sessionId:randomUUID(),expiresAt:new Date(Date.now()+900000).toISOString(),ragInstallations:[]};
    const context=await configurationContext(descriptor,noop);return {...f,descriptor,context,editor:(authorize=noop)=>new ConfigurationEditor(context,authorize)};
}
export async function configurationSession(f:Awaited<ReturnType<typeof configurationFixture>>,permit=noop){let address='';const report=await openProjectConfiguration(f.descriptor,noop,permit,async url=>{address=url;return true;}),url=new URL(address);
    const post=(route:string,value:unknown,csrf='',origin=url.origin)=>fetch(url.origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Configuration-CSRF':csrf},body:JSON.stringify(value)});
    return {report,url,post,bootstrap:()=>post('/session',{token:url.hash.slice(1)})};
}
