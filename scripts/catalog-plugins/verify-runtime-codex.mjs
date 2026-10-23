import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import codexSource from '../../services/shared/codex-connector-source.cjs';

/** Only a verified repository supply with the immutable source and package ABI uses an owned wrapper. */
function managedSupply(tool){
    const source=tool.asset.source;
    return source.type==='git'&&codexSource.isPreparedCodexRepository({url:source.repository,commit:source.commit,subdirectory:source.path})
        &&tool.artifacts.length>0&&codexSource.isManagedCodexConnectorPackage({plugin:{kind:tool.publication.kind},config:tool.publication.config});
}

/** Exercise the actual wizard factory inside the same sandbox; no fake hook or auth/transport invocation. */
export async function codexRuntimeEntrypoint(tool,entrypoint,profile,nodeExecutable){
    if(!managedSupply(tool))return entrypoint;
    const providerId='neurocenter-codex-'+randomBytes(8).toString('hex');
    const options={providerId,projectRoot:profile.project,codexHome:path.join(profile.home,'codex'),
        bridgeCommand:[nodeExecutable,path.join(profile.root,'unavailable-bridge.mjs')],
        preparationId:randomUUID(),setupJobId:randomUUID(),schemaDigest:randomBytes(32).toString('hex')};
    const wrapper=path.join(profile.root,'codex-owned-wrapper.mjs');
    await fs.writeFile(options.bridgeCommand[1],"throw new Error('Runtime verification never authorizes provider requests');\n",{flag:'wx',mode:0o400});
    await fs.writeFile(wrapper,`import {createManagedCodexPlugin} from ${JSON.stringify(pathToFileURL(entrypoint).href)};
const options=${JSON.stringify(options)};
const factory=createManagedCodexPlugin(options);
const invalid=()=>{const error=new Error('Managed Codex hooks do not match the owned wrapper contract');error.verificationCode='plugin-invalid-hooks';throw error;};
export default async input=>{
    const hooks=await factory(input);
    if(!hooks||typeof hooks.config!=='function'||hooks.auth?.provider!==options.providerId||typeof hooks.auth.loader!=='function')invalid();
    const manual={options:{apiKey:'unrelated-manual-provider'}},provider={options:{}};
    const configuration={provider:{[options.providerId]:provider,manual}};
    await hooks.config(configuration);
    const loaded=await hooks.auth.loader();
    if(configuration.provider.manual!==manual||manual.options.apiKey!=='unrelated-manual-provider'
        ||provider.options.apiKey!=='codexbridge-managed'||provider.options.baseURL!=='https://chatgpt.com/backend-api/codex'
        ||typeof provider.options.fetch!=='function'||loaded?.apiKey!==provider.options.apiKey
        ||loaded.baseURL!==provider.options.baseURL||loaded.fetch!==provider.options.fetch)invalid();
    return hooks;
};
`,{flag:'wx',mode:0o400});
    return wrapper;
}
