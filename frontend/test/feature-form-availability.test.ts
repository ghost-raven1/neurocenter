import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys} from '../src/features/FeatureFlags/types';
import type {IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
import {ModelEditModal} from '../src/features/ModelCatalog/ModelEditModal';

const ui=vi.hoisted(()=>({submit:undefined as undefined|((values:unknown)=>void),create:vi.fn(),saved:vi.fn(),close:vi.fn()}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({captureOwner:()=>()=>true})}));
vi.mock('../src/features/ModelCatalog/api',()=>({modelCatalogApi:{create:ui.create}}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children,input=()=>null;
    return{Form:Object.assign(({children,onFinish}:{children:ReactNode;onFinish:(value:unknown)=>void})=>{ui.submit=onFinish;return children;},
        {useForm:()=>[{}],useWatch:(name:string)=>name==='runtime'?'remote-openai':'chat',Item:()=>null}),
        Modal:content,Space:content,Button:content,Tooltip:content,Alert:()=>null,Input:Object.assign(input,{TextArea:input}),InputNumber:input,Select:input};
});
const values={name:'Моя модель',description:'Черновик',model:'actual-model',modelVersion:'v1',runtime:'remote-openai',capability:'chat'};
const flush=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function render(enabled:boolean|null):void {
    const data=enabled===null?null:{flags:Object.fromEntries(featureFlagKeys.map(key=>[key,enabled])),configured:Object.fromEntries(featureFlagKeys.map(key=>[key,enabled])),blockedBy:Object.fromEntries(featureFlagKeys.map(key=>[key,[]]))}as IEvaluatedFeatureFlags;
    renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider,{value:{data,loading:false,error:null,refresh:async()=>undefined}},
        createElement(ModelEditModal,{onClose:ui.close,onSaved:ui.saved})));
}
beforeEach(()=>{vi.clearAllMocks();ui.submit=undefined;ui.create.mockResolvedValue({id:'new'});ui.saved.mockResolvedValue(undefined);});

describe('Submit и Enter проверяют функцию независимо от кнопки',()=>{
    it.each([false,null])('Состояние %s не отправляет форму и не очищает черновик',async enabled=>{
        render(enabled);ui.submit?.(values);await flush();expect(ui.create).not.toHaveBeenCalled();expect(ui.saved).not.toHaveBeenCalled();expect(ui.close).not.toHaveBeenCalled();
    });
    it('Подтверждённое разрешение сохраняет форму обычным флоу',async()=>{
        render(true);ui.submit?.(values);await flush();expect(ui.create).toHaveBeenCalledOnce();expect(ui.saved).toHaveBeenCalledOnce();expect(ui.close).toHaveBeenCalledOnce();
    });
});
