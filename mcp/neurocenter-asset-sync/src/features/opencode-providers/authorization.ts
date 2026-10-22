import {api,hash} from '../../bridge/state.js';
import {readPrivateConfiguration} from '../local-configuration/private-store.js';
import {providerContext,stale} from './context.js';
import {assertOwnedProvider} from './engine.js';
import type {OpenCodeProviderDescriptor} from './contract.js';
import type {Package} from '../../bridge/package.js';
import {loadConnector} from './connector.js';
/** A managed auth-only connector may start a new request only for the exact committed local profile. */
export async function authorizeManagedProvider(input:unknown,permit:(body:unknown)=>Promise<unknown>=body=>api('opencode-provider/authorize',body)){
    const value=input as Record<string,unknown>|null,keys=['providerId','projectRoot','preparationId','setupJobId','schemaDigest','phase'];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||value.phase!=='request'
        ||typeof value.preparationId!=='string'||!/^[a-f0-9-]{36}$/.test(value.preparationId)||typeof value.setupJobId!=='string'||!/^[a-f0-9-]{36}$/.test(value.setupJobId))throw stale();
    const prepared=await readPrivateConfiguration<{descriptor:OpenCodeProviderDescriptor;site:string;preparationId:string;openJobId?:string;connectorPackage?:Package}>(hash('opencode-provider-preparation:'+value.preparationId));
    if(!prepared||prepared.preparationId!==value.preparationId||prepared.openJobId!==value.setupJobId||prepared.descriptor.providerKind!=='codex-bridge'||prepared.descriptor.providerId!==value.providerId||prepared.descriptor.schemaDigest!==value.schemaDigest)throw stale();
    const context=await providerContext(prepared.descriptor,async()=>{},prepared.connectorPackage);
    const current=async()=>{const proof=await assertOwnedProvider(context),authorization=proof.receipt.authorization;if(!authorization||authorization.preparationId!==value.preparationId||authorization.setupJobId!==value.setupJobId)throw stale();};
    if(context.site!==prepared.site||context.root!==value.projectRoot)throw stale();await current();await loadConnector(context);
    const admitted=await permit({jobId:value.setupJobId,phase:'request',providerId:value.providerId,schemaDigest:value.schemaDigest});if(!admitted||typeof admitted!=='object'||(admitted as {ok?:unknown}).ok!==true)throw stale();await context.assertCurrent();await current();
    return {ok:true as const,allowed:true as const};
}
