import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
import {EmbeddingTargetFields,useEmbeddingTarget} from '../src/features/ProjectEmbedding/EmbeddingTarget';
import {embeddingConnectionBlocker} from '../src/features/ProjectEmbedding/connection';
import {bridgeOperationBlocker} from '../src/features/McpBridge/readiness';
import {ragUiFixture} from './ragUiFixture';

const ui=vi.hoisted(()=>({fixture:undefined as ReturnType<typeof ragUiFixture>|undefined}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'qa-profile-values'})}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>ui.fixture!.bridge}));
let target:ReturnType<typeof useEmbeddingTarget>;
function Subject(){target=useEmbeddingTarget('prj-one');return createElement(EmbeddingTargetFields,{target});}
beforeEach(()=>{
    ui.fixture=ragUiFixture();const {device,item}=ui.fixture;device.report.root='/qa/root';device.report.bridgeVersion='0.9.12';
    device.report.capabilities!.push('hosted-rag-reindex-v1','hosted-rag-grants-v1');item.hostedEmbedding={supported:true,reindexSupported:true};
    item.inspection={schemaVersion:1,projectId:'prj-one',bindingId:item.bindingId!,assetId:item.assetId,assetKind:'mcp',version:item.version,manifest:item.manifest,checkedAt:'2026-10-21T00:00:00Z',readiness:'unverified',state:'checked',status:'synced',issues:[]};
});
it('Actual model target on0.9.12 explains update without blocking ordinary managed file operations',()=>{
    const html=renderToStaticMarkup(createElement(Subject));expect(target.blocked).toBe(true);expect(target.value).toBeUndefined();expect(html).toContain('Обновите мост');
    expect(embeddingConnectionBlocker(ui.fixture!.device,ui.fixture!.binding)).toContain('Обновите мост');
    expect(bridgeOperationBlocker(ui.fixture!.device)).toBe('');
});
it('Corrected0.9.13 capability restores the same exact installation target without changing its wire schema',()=>{
    const {device,item,binding}=ui.fixture!;device.report.bridgeVersion='0.9.13';device.report.capabilities!.push('hosted-rag-profile-values-v1');
    renderToStaticMarkup(createElement(Subject));expect(target.blocked).toBe(false);expect(target.reason).toBe('');
    expect(target.value).toEqual({deviceId:device.id,assetId:item.assetId,assetKind:'mcp',version:item.version,expectedManifest:item.manifest,expectedBindingId:binding.bindingId,expectedInstanceId:binding.instanceId});
    expect(embeddingConnectionBlocker(device,binding)).toBe('');
});
