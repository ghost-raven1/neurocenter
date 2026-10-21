import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import Rag from '../src/modules/Rag/Rag';
import {RagSyncStatus} from '../src/modules/Rag/RagSyncStatus';

const ui=vi.hoisted(()=>({triggers:[]as string[][]}));
vi.mock('../src/core/hooks',()=>({useAppDispatch:()=>vi.fn()}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:()=>undefined}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({rag:{list:[{projectKey:'prj-one',rowCount:0,dimension:2560,lastSyncedAt:null}],loading:false,authScope:'owner'},projects:{list:[{id:'prj-one',name:'Проект с понятным именем'}]},userBlock:{user:{projectRoles:[]}}})}));
vi.mock('react-router-dom',()=>({useHistory:()=>({push:vi.fn()}),Link:({to,children}:{to:string;children:ReactNode})=>createElement('a',{href:to},children)}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return{Typography:{Text:content,Title:content,Paragraph:content},Card:content,Alert:content,Empty:content,Tooltip:({children,trigger,title}:{children:ReactNode;trigger:string[];title:string})=>{ui.triggers.push(trigger);return createElement('span',{'data-tooltip':title},children);},
        Button:({'aria-label':label,children}:{'aria-label'?:string;children?:ReactNode})=>createElement('button',{'aria-label':label},children),
        Table:({columns,dataSource}:{columns:Array<{key:string;dataIndex?:string;render?:(value:unknown,row:Record<string,unknown>)=>ReactNode}>;dataSource:Array<Record<string,unknown>>})=>createElement('div',null,dataSource.map(row=>createElement('div',{key:String(row.projectKey)},columns.map(column=>createElement('span',{key:column.key},column.render?column.render(row[column.dataIndex??''],row):String(row[column.dataIndex??'']??''))))))};
});

describe('Компактный список баз знаний',()=>{
    it('Имя проекта является настоящей ссылкой на его каноническую страницу',()=>{const html=renderToStaticMarkup(createElement(Rag));expect(html).toContain('href="/projects/prj-one">Проект с понятным именем</a>');});
    it('Несинхронизированное состояние доступно клавиатурой, hover и click без длинной строки в колонке',()=>{const html=renderToStaticMarkup(createElement(RagSyncStatus,{hasFragments:false}));expect(html).toContain('aria-label="Знания ещё не синхронизированы"');expect(ui.triggers.at(-1)).toEqual(['hover','focus','click']);expect(html).toContain('В серверной копии пока нет фрагментов');});
    it('Наличие фрагментов не выдаётся за проверенную модель/индекс',()=>{const html=renderToStaticMarkup(createElement(RagSyncStatus,{hasFragments:true}));expect(html).toContain('aria-label="На сервере есть фрагменты знаний"');expect(html).toContain('Готовность индекса и модель проверяются');expect(html).not.toContain('Знания проверены');});
});
