import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import AppCard,{type IStoreApp} from '../src/modules/Store/AppCard';
import {fromPlugin} from '../src/modules/Store/storeHelpers';
import type {IAiPlugin} from '../src/core/api/interfaces';

const app:IStoreApp={id:'packaged-tool',name:'Упакованный инструмент',kind:'mcp',description:'Описание инструмента.',version:3,tags:[],origin:'https://www.npmjs.com/package/@team/tool'};
const render=(value:IStoreApp)=>renderToStaticMarkup(createElement(AppCard,{app:value,onView:()=>{},action:createElement('button',null,'Добавить в проект')}));

describe('Понятная карточка упакованного инструмента',()=>{
 it('Не теряет ревизию поставки при преобразовании карточки API',()=>{
  const plugin={...app,kind:'mcp',revision:'1.2.3',config:null,files:[],createdAt:'',updatedAt:'',compatibility:null} as IAiPlugin;
  expect(fromPlugin(plugin)).toMatchObject({version:3,revision:'1.2.3'});
 });
 it('Различает выпуск инструмента и редакцию карточки каталога',()=>{
  const html=render({...app,revision:'1.2.3'});
  expect(html).toContain('Поставка 1.2.3');expect(html).toContain('Редакция 3');expect(html).toContain('npm · @team/tool');
  expect(html).not.toContain('В каталоге');
 });
 it('Не оставляет пустой блок тегов и не обещает отсутствующую инструкцию',()=>{
  const html=render({...app,description:'   '});
  expect(html).not.toContain('store-card__tags');expect(html).toContain('Описание пока не добавлено.');expect(html).not.toContain('прочитать его инструкцию');
 });
 it('Сохраняет полное длинное название и отдельное действие в проект',()=>{
  const name='Инструмент с длинным названием для анализа проектов и поиска ошибок в исходниках';
  const html=render({...app,name});expect(html).toContain(name);expect(html).toContain('Подробнее: '+name);expect(html).toContain('Добавить в проект');
 });
});
