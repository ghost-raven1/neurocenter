import {isDeepStrictEqual} from 'node:util';
import type {Receipt} from '../../bridge/installation-receipt.js';
import {assetKey,mcpConfigKey} from '../../bridge/installation-receipt.js';
import {verify} from '../../bridge/package.js';
import {projectFolder} from '../../bridge/workspace.js';
import {inspectInstallation} from '../../bridge/installation-inspection.js';
import {configurationConnection,launcherDescriptorKey,type LauncherDescriptor} from '../local-configuration/launcher-descriptor.js';
import {readPrivateConfiguration} from '../local-configuration/private-store.js';
import {localRagCore} from '../rag-core/contract.js';
import {readHostedRagEmbedding} from '../rag-hosted/profile.js';
import {readMcpConfiguration,parseLocalConfiguration} from '../local-configuration/index.js';

export interface ManagedRagEmbedding {provider?:string;model?:string;baseUrl?:string;vectorDimension?:number}
/** Default-профиль доказывается текущей private-квитанцией launcher, а не размерностью или именем инструмента. */
export async function managedRagMcpEmbedding(root:string,projectId:string,key:string,source:unknown):Promise<ManagedRagEmbedding|undefined>{
    const receipt=source as Receipt|undefined;
    if(!receipt||!receipt.config||!/^[a-f0-9]{24}$/.test(key)
        ||!/^[a-f0-9]{64}$/.test(receipt.manifest)||!Number.isSafeInteger(receipt.version))return undefined;
    try{
        if(await projectFolder(projectId)!==root)return undefined;
        const descriptor=await readPrivateConfiguration<LauncherDescriptor>(await launcherDescriptorKey(projectId,key,receipt.manifest));
        if(!descriptor||descriptor.schemaVersion!==1||descriptor.projectId!==projectId)return undefined;
        const pkg=descriptor.pkg;verify(pkg);
        if(receipt.config.key!=='neurocenter_'+key&&receipt.config.key!==mcpConfigKey(pkg))return undefined;
        if(pkg.plugin.kind!=='mcp'||pkg.plugin.version!==receipt.version||pkg.manifest.sha256!==receipt.manifest||assetKey(pkg)!==key
            ||!localRagCore(pkg)||pkg.config?.entrypoint!=='opencode-rag.mjs'||JSON.stringify(pkg.config.args)!=='["mcp"]'
            ||!isDeepStrictEqual(configurationConnection(root,pkg),receipt.config.value))return undefined;
        const inspection=await inspectInstallation(projectId,pkg);
        if(inspection.state!=='checked'||inspection.status!=='synced')return undefined;
        const hosted=await readHostedRagEmbedding(root,projectId,pkg);if(hosted)return hosted;
        const configuration=parseLocalConfiguration(pkg)?await readMcpConfiguration(projectId,pkg,undefined,async()=>{}):undefined;
        const env={...process.env,...configuration?.env};
        return {...env.NEUROCENTER_RAG_EMBEDDING_PROVIDER?{provider:env.NEUROCENTER_RAG_EMBEDDING_PROVIDER}:{},
            ...env.NEUROCENTER_RAG_EMBEDDING_MODEL?{model:env.NEUROCENTER_RAG_EMBEDDING_MODEL}:{},
            ...env.NEUROCENTER_RAG_EMBEDDING_URL?{baseUrl:env.NEUROCENTER_RAG_EMBEDDING_URL}:{}};
    }catch{return undefined;}
}
