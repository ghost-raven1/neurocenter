import {describe,expect,it,vi} from 'vitest';
import type {AccessDb} from '../src/access/access-db';
import {CatalogController} from '../src/catalog/catalog.controller';
import {CatalogService} from '../src/catalog/catalog.service';
import {CatalogDb} from '../src/catalog/catalog-db';

/** Неверный JSON не должен стать успешным пустым PATCH после object spread. */
describe('Форма запроса настроек проекта',()=>{
    it.each([null,[],42,'не объект'])('Отклоняет тело %j до чтения проекта',async body=>{
        const getProject=vi.fn().mockResolvedValue({id:'prj-review',name:'Проверка',retention:30,quota:{}});
        const query=vi.fn();
        const db=Object.assign(Object.create(CatalogDb.prototype),{getProject,pool:{query}});
        const service=Object.assign(Object.create(CatalogService.prototype),{db}) as CatalogService;
        const claims=vi.fn().mockResolvedValue({email:'review@example.invalid',userRoles:['Главный админ'],projects:[],pluginIds:[],skillPaths:[]});
        const controller=new CatalogController(service,{claims} as unknown as AccessDb);
        const request={headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email:'review@example.invalid',activeRole:'Главный админ'}))}};
        const update=controller.updateProject as (...args:unknown[])=>Promise<unknown>;
        await expect(update.call(controller,'prj-review',body,request)).rejects.toMatchObject({status:400});
        expect(getProject).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
    });
});
