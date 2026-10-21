import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import AppCard,{type IStoreApp} from '../src/modules/Store/AppCard';

const buttons=vi.hoisted(()=>new Map<string,()=>void>());
vi.mock('antd',()=>({
 Card:({title,children,extra}:{title:ReactNode;children:ReactNode;extra:ReactNode})=>createElement('article',null,title,extra,children),
 Button:({children,onClick,'aria-label':label}:{children:ReactNode;onClick:()=>void;'aria-label':string})=>{buttons.set(label,onClick);return createElement('button',{'aria-label':label},children);},
 Typography:{Text:({children}:{children:ReactNode})=>children,Paragraph:({children}:{children:ReactNode})=>children},
 Tag:({children}:{children:ReactNode})=>children,
}));
const app:IStoreApp={id:'packaged',name:'Упакованный инструмент',kind:'mcp',description:'Описание',version:1,tags:[],origin:''};
beforeEach(()=>buttons.clear());
describe('Действия карточки не пересекаются',()=>{
 it('Открывает детали только кнопкой названия; добавление в проект остаётся отдельным действием',()=>{
  const onView=vi.fn(),onAdd=vi.fn();
  const card=createElement(AppCard,{app,onView,action:createElement('button',{onClick:onAdd},'Добавить в проект')});renderToStaticMarkup(card);
  expect(onView).not.toHaveBeenCalled();expect(onAdd).not.toHaveBeenCalled();
  buttons.get('Подробнее: '+app.name)!();expect(onView).toHaveBeenCalledOnce();expect(onAdd).not.toHaveBeenCalled();
  expect(card.props.action.props.onClick).toBe(onAdd);expect(card.props.onClick).toBeUndefined();
 });
});
