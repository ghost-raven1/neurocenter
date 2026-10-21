import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {RequestTargetPicker} from '../src/features/CatalogRequests/RequestTargetPicker';
import {RequestFormModal} from '../src/features/CatalogRequests/RequestFormModal';
import {catalogRequestsApi} from '../src/features/CatalogRequests/api';
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'author',captureOwner:()=>()=>true})}));
vi.mock('../src/features/CatalogRequests/api',()=>({catalogRequestsApi:{targets:vi.fn()}}));
const selectors=vi.hoisted(()=>({options:[] as Array<{value:string;label:string;disabled:boolean}>,names:[] as string[],modals:[] as Array<{centered?:boolean;bodyStyle?:{maxHeight?:string;overflowY?:string}}>}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Input:Object.assign(()=>null,{TextArea:()=>null}),Modal:({children,centered,bodyStyle}:{children?:ReactNode;centered?:boolean;bodyStyle?:{maxHeight?:string;overflowY?:string}})=>{selectors.modals.push({centered,bodyStyle});return children;},Space:content,Button:content,Typography:{Text:content,Paragraph:content},Alert:content,
        Select:({options}:{options:Array<{value:string;label:string;disabled:boolean}>})=>{selectors.options=options;return createElement('span',null,options.map(item=>item.label).join('|'));},
        Form:Object.assign(({children,name}:{children?:ReactNode;name:string})=>{selectors.names.push(name);return children;},{useForm:()=>[{}],useWatch:()=>undefined,Item:content})};
});

describe('Недоступные карточки и формы имеют однозначные состояния',()=>{
    it.each([false,null])('Historical target availability=%s cannot be reselected as a verified result',available=>{
        const target={type:'mcp' as const,id:'target',name:'Карточка',version:3,available};renderToStaticMarkup(createElement(RequestTargetPicker,{assetType:'mcp',value:target.id,initial:target}));
        expect(selectors.options[0]).toMatchObject({value:'target',disabled:true});expect(selectors.options[0].label).toContain(available===false?'недоступна':'не проверена');expect(catalogRequestsApi.targets).not.toHaveBeenCalled();
    });
    it('A verified target snapshot stays selected while a different search result loads',()=>{
        const target={type:'model' as const,id:'model',name:'Модель',version:4,available:true};renderToStaticMarkup(createElement(RequestTargetPicker,{assetType:'model',value:target.id,initial:target}));expect(selectors.options[0]).toMatchObject({value:'model',disabled:false});
    });
    it('A different asset kind never inherits the previous target selection',()=>{
        renderToStaticMarkup(createElement(RequestTargetPicker,{assetType:'skill',value:'target',initial:{type:'mcp',id:'target',name:'Другой тип',version:3,available:true}}));expect(selectors.options).toEqual([]);
    });
    it('Two mounted intake forms use separate DOM field namespaces',()=>{
        selectors.names=[];selectors.modals=[];const props={open:true,projects:[],onClose:()=>undefined,onSaved:()=>undefined};renderToStaticMarkup(createElement('div',null,createElement(RequestFormModal,props),createElement(RequestFormModal,props)));
        expect(selectors.names).toHaveLength(2);expect(new Set(selectors.names).size).toBe(2);expect(selectors.modals).toEqual(Array(2).fill({centered:true,bodyStyle:{maxHeight:'calc(100dvh - 180px)',overflowY:'auto'}}));
    });
});
