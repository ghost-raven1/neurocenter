import {describe,expect,it} from 'vitest';
import {pagination} from '../src/catalog/pagination';
import {validateProjectSettings} from '../src/catalog/project-validation';

describe('Параметры страниц каталога',()=>{
    it('Подставляет значения по умолчанию и ограничивает размер страницы',()=>{expect(pagination({})).toEqual({page:1,size:20});expect(pagination({size:'10000'},100)).toEqual({page:1,size:100});});
    it.each([-1,0,1.5,'NaN','Infinity','abc',[],{},null])('Неверный номер страницы отклоняется до SQL: %j',page=>{expect(()=>pagination({page})).toThrow('положительным целым');});
    it.each([-1,0,1.5,'NaN','Infinity',[],{}])('Неверный размер страницы отклоняется до SQL: %j',size=>{expect(()=>pagination({size})).toThrow('положительным целым');});
    it('Небезопасное смещение не передаётся в PostgreSQL',()=>{expect(()=>pagination({page:Number.MAX_SAFE_INTEGER,size:100})).toThrow('слишком велик');});
});
describe('Настройки проекта',()=>{
    it.each(['prj-foreign','PRJ-project'])('Имя %s не занимает пространство постоянных ID',name=>{expect(()=>validateProjectSettings({name})).toThrow('зарезервирован');});
    it.each([null,[],{name:123},{name:['Имя']},{state:'UNKNOWN'},{state:['ACTIVE']},{retention:-1},{retention:1.5},{retention:'10'},{retention:101},{quotas:[]},{quotas:{currentBytesLimit:-1}},{quotas:{currentBytesLimit:1.5}},{quotas:{currentBytesLimit:'100'}}])('Неверные настройки не сохраняются: %j',input=>{expect(()=>validateProjectSettings(input)).toThrow();});
    it('Допускает русское название, известное состояние и нулевой лимит',()=>{expect(()=>validateProjectSettings({name:'Рабочий проект',state:'ARCHIVED',retention:100,quotas:{currentBytesLimit:0}})).not.toThrow();});
});
