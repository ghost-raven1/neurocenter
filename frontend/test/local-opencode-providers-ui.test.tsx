// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LocalOpenCodeProvidersStep} from '../src/features/LocalOpenCodeProviders/LocalOpenCodeProvidersStep';
const h=vi.hoisted(()=>({value:{} as any}));
vi.mock('../src/features/LocalOpenCodeProviders/useLocalProviders',()=>({useLocalProviders:()=>h.value}));
let root:Root,container:HTMLDivElement;const next=vi.fn();
const button=(label:string)=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label)!;
const render=async(cliVersion:string|null='1.14.48')=>{await act(async()=>root.render(createElement(LocalOpenCodeProvidersStep,{bridge:{} as never,enabled:true,onContinue:next,cliVersion:cliVersion??undefined})));};
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('matchMedia',(media:string)=>({matches:false,media,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:()=>false}));
    h.value={canRead:true,canInspect:true,canOpen:true,blocker:'',openingBlocker:'',controller:{start:vi.fn(),refresh:vi.fn(),replay:vi.fn(),cancel:vi.fn()},state:{busy:false,error:'',storageError:'',denied:false,jobs:{},replayKinds:[],inventory:{providers:[{id:'openai',modelIds:[],hasConfiguration:false,hasAuthentication:true,authentication:'oauth',enabled:true}],issues:[]}}};
    container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
it('keeps several-provider setup local, shows OAuth presence truthfully and makes history secondary',async()=>{
    await render();expect(container.textContent).toContain('OAuth сохранён');expect(container.querySelectorAll('input,textarea')).toHaveLength(0);expect(button('Обновить историю').closest('details')).not.toBeNull();expect(container.querySelector('details')?.open).toBe(false);
    await act(async()=>button('Настроить на компьютере').click());expect(h.value.controller.start).toHaveBeenCalledExactlyOnceWith('open-opencode-global-providers');expect(next).not.toHaveBeenCalled();
    await act(async()=>button('Использовать текущую настройку').click());expect(next).toHaveBeenCalledOnce();
});
it('OFF allows inventory/recovery but disables opening; a partial or unknown inventory never advances',async()=>{
    h.value.canOpen=false;await render();expect(button('Перечитать провайдеров').disabled).toBe(false);expect(button('Настроить на компьютере').disabled).toBe(true);
    h.value.state.inventory.issues=['source-changed'];await render();expect(button('Использовать текущую настройку').disabled).toBe(true);h.value.state.inventory=undefined;await render();expect(button('Использовать текущую настройку').disabled).toBe(true);expect(next).not.toHaveBeenCalled();
});
it('long configured model identifiers remain complete inside the feature’s wrapping text owner',async()=>{
    const model='m'.repeat(240);h.value.state.inventory.providers[0].modelIds=[model];await render();
    expect(container.querySelector('.local-opencode-providers__models')?.textContent).toContain(model);expect(container.querySelector('.local-opencode-providers__identity')?.textContent).toBe('openai');expect(container.querySelector('.local-opencode-providers')).not.toBeNull();
});
it('known unsupported CLI exposes old files only and can continue without claiming provider readiness; unknown CLI cannot continue',async()=>{
    h.value.state.inventory=undefined;await render('2.0.0');expect(container.textContent).toContain('Файлы прежнего формата');expect(container.textContent).toContain('Для этой версии доступно только чтение прежних файлов. Настройте провайдеров в OpenCode.');expect(button('Настроить на компьютере').disabled).toBe(true);
    await act(async()=>button('Продолжить с настройкой OpenCode').click());expect(next).toHaveBeenCalledOnce();await render(null);expect(button('Настроить на компьютере').disabled).toBe(true);expect(button('Использовать текущую настройку').disabled).toBe(true);expect(next).toHaveBeenCalledOnce();
});
