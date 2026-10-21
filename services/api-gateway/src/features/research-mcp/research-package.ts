import {BadRequestException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import {normalizeRuntimeArtifacts} from '../../../../shared/runtime-artifacts.cjs';
import type {HostedMcpClaim} from '../mcp-host/ticket';
import {hostRuntimeTarget} from '../mcp-host/host-target';

export const RESEARCH_TOOL_NAMES=['web_search_exa','web_fetch_exa'] as const;
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.entries(value)
    .filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)])):value;
const invalid=()=>new BadRequestException('Нужен одобренный пакет поискового MCP с проверенной поставкой Gateway.');

/** Accept only the full immutable native package, including config and every file hash. */
export function researchPackage(raw:unknown,target=hostRuntimeTarget()):HostedMcpClaim {
    if(!object(raw)||raw.schemaVersion!==5||!object(raw.plugin)||raw.plugin.kind!=='mcp'||!object(raw.config)
        ||raw.config.transport!=='stdio'||!object(raw.config.extra)||raw.config.extra.hostedMcp!==true
        ||!object(raw.manifest)||!Array.isArray(raw.files)||raw.files.length!==raw.manifest.filesCount
        ||typeof raw.plugin.id!=='string'||!raw.plugin.id||typeof raw.plugin.name!=='string'||!raw.plugin.name||raw.plugin.name.length>200
        ||!Number.isSafeInteger(raw.plugin.version)||raw.plugin.version<1||!/^([a-f0-9]{64})$/.test(raw.manifest.sha256))throw invalid();
    const descriptor=raw.config.extra.researchMcp;
    if(!object(descriptor)||descriptor.adapter!=='exa'||!Array.isArray(descriptor.tools)||descriptor.tools.length!==2
        ||!RESEARCH_TOOL_NAMES.every(name=>descriptor.tools.includes(name)))throw invalid();
    const paths=new Set<string>();
    for(const file of raw.files){
        if(!object(file)||typeof file.path!=='string'||!file.path||paths.has(file.path)||typeof file.content!=='string'
            ||![undefined,'base64'].includes(file.encoding)||!Number.isSafeInteger(file.size)||file.size<0||file.size>1024*1024)throw invalid();
        paths.add(file.path);const bytes=Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8');
        if(bytes.length!==file.size||digest(bytes)!==file.sha256||file.encoding==='base64'&&bytes.toString('base64')!==file.content)throw invalid();
    }
    const content={schemaVersion:raw.schemaVersion,plugin:raw.plugin,config:raw.config,
        files:raw.files.map(({path,size,sha256,encoding}:any)=>({path,size,sha256,...(encoding?{encoding}:{})})).sort((a:any,b:any)=>a.path<b.path?-1:a.path>b.path?1:0)};
    if(digest(JSON.stringify(canonical(content)))!==raw.manifest.sha256)throw invalid();
    let artifacts;try{artifacts=normalizeRuntimeArtifacts(raw.config.extra.runtimeArtifacts);}catch{throw invalid();}
    const artifact=artifacts.find(item=>item.target===target);if(!artifact)throw invalid();
    return {artifactSha256:artifact.sha256,entrypoint:artifact.entrypoint,executable:artifact.executable??false,
        name:raw.plugin.name,compressedBytes:artifact.compressedBytes,unpackedBytes:artifact.unpackedBytes,filesCount:artifact.filesCount,researchSessionId:randomUUID(),exp:Date.now()+5*60*1000};
}
