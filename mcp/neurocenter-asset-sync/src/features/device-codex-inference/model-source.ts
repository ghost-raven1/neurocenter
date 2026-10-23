import os from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {readOpenCodeModelMetadata} from '../../bridge/opencode-model-scan.js';
import {projectFolder} from '../../bridge/workspace.js';
import {InstallationPlan} from '../../bridge/installation-plan.js';
import {providerContext} from '../opencode-providers/context.js';
import {assertOwnedProvider} from '../opencode-providers/engine.js';
import {receiptFile,type ProviderReceipt} from '../opencode-providers/receipt.js';
import type {Package} from '../../bridge/package.js';
import type {DeviceCodexContext} from './contract.js';

/** Re-read the effective provider before each send; stale local configuration cannot reuse a server model pin. */
export async function assertCodexModelSource(context:DeviceCodexContext,deviceId:string,authorize:()=>Promise<unknown>,checkLocal:()=>Promise<unknown>=authorize):Promise<void>{
    await authorize();
    const root=context.source.scope==='project'?await projectFolder(context.source.projectId):os.homedir();
    const source=context.source.scope==='global'?{scope:'global' as const,deviceId}:context.source;
    const scan=await readOpenCodeModelMetadata(root,source,{readAuth:false,authorize:checkLocal});
    if(scan.warnings.some(warning=>['invalid-json','unsafe-path','read-failed','source-changed','entry-limit','ambiguous-config'].includes(warning)))throw new Error('Настройка OpenCode недоступна.');
    const expected=context.expectedCandidate;
    const matches=scan.candidates.filter(candidate=>candidate.provider===expected.provider&&candidate.configKey===expected.configKey);
    const candidate=matches[0];
    if(matches.length!==1||!candidate||candidate.blocker!=='codex-local-auth'||candidate.runtime!=='remote-openai'||candidate.model!==context.model||candidate.capability!==context.capability||candidate.parameterIssues?.length)throw new Error('Модель OpenCode изменилась.');
    const identity={provider:candidate.provider,...(candidate.configKey?{configKey:candidate.configKey}:{}),model:candidate.model,modelVersion:candidate.modelVersion,capability:candidate.capability,baseUrl:candidate.baseUrl,...(candidate.options?{options:candidate.options}:{})};
    if(!isDeepStrictEqual(identity,expected))throw new Error('Параметры OpenCode изменились.');
    if(/^neurocenter-codex-[a-f0-9]{16}$/.test(candidate.provider)){
        if(context.source.scope!=='project')throw new Error('Управляемый провайдер требует исходную папку проекта.');
        const raw=await new InstallationPlan(root).read(receiptFile(candidate.provider));
        if(!raw)throw new Error('Квитанция провайдера Codex недоступна.');
        const receipt=JSON.parse(raw) as ProviderReceipt,pkg=context.connectorPackage as unknown as Package;
        const owned=await providerContext({schemaVersion:1,deviceId,projectId:context.source.projectId,bindingId:context.source.bindingId,instanceId:context.source.instanceId,
            providerId:candidate.provider,providerKind:'codex-bridge',schemaDigest:receipt.schemaDigest,expectations:null,
            connector:{assetId:pkg.plugin.id,version:pkg.plugin.version,manifest:pkg.manifest.sha256,sourceCommit:(pkg.config?.extra?.codexConnector as {sourceCommit:string}).sourceCommit}},authorize,pkg);
        await assertOwnedProvider(owned);
    }
    await authorize();
}
