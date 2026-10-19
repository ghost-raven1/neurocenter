import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {AccessDb} from '../src/access/access-db';
import type {IAccessClaims} from '../src/access/access.model';
import {CatalogController} from '../src/catalog/catalog.controller';
import {CatalogService} from '../src/catalog/catalog.service';

describe('Область чтения списка и подробностей операций',()=>{
    const email='reader@example.test';
    const request=(activeRole='Наблюдатель')=>({headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole}))}});
    const catalog={getOperation:vi.fn(),listOperations:vi.fn()};
    const access={claims:vi.fn()};
    const controller=new CatalogController(catalog as unknown as CatalogService,access as unknown as AccessDb);
    const claims:IAccessClaims={email,userRoles:['Наблюдатель'],projects:[{projectId:'prj-own',projectName:'Свой проект',role:'Наблюдатель'}],pluginIds:[],skillPaths:[]};
    beforeEach(()=>{
        vi.clearAllMocks();
        access.claims.mockResolvedValue(claims);
        catalog.getOperation.mockResolvedValue({operationId:'op-own'});
    });
    it('Список и detail получают одну свежую область, независимо от параметров клиента',async()=>{
        await controller.listOperations({page:'2',size:'10',projectId:'prj-foreign',state:'FAILED'},request());
        await controller.getOperation('op-own',request());
        const scope={projectIds:['prj-own','Свой проект'],actor:email};
        expect(catalog.listOperations).toHaveBeenCalledWith(2,10,'prj-foreign','FAILED',scope);
        expect(catalog.getOperation).toHaveBeenCalledWith('op-own',scope);
        expect(access.claims).toHaveBeenNthCalledWith(1,email);
        expect(access.claims).toHaveBeenNthCalledWith(2,email);
    });
    it('После отзыва проекта исполнитель не сохраняет прежнюю область по старому запросу',async()=>{
        await controller.getOperation('op-own',request());
        access.claims.mockResolvedValue({...claims,projects:[]});
        await controller.getOperation('op-own',request());
        expect(catalog.getOperation.mock.calls.at(-1)).toEqual(['op-own',{projectIds:[],actor:email}]);
    });
    it('После отзыва активной роли список и detail запрещены до SQL каталога',async()=>{
        access.claims.mockResolvedValue({...claims,userRoles:[]});
        await expect(controller.listOperations({},request())).rejects.toMatchObject({status:403});
        await expect(controller.getOperation('op-foreign',request())).rejects.toMatchObject({status:403});
        expect(catalog.listOperations).not.toHaveBeenCalled();
        expect(catalog.getOperation).not.toHaveBeenCalled();
    });
    it('Старая сессия главного администратора не создаёт неограниченный scope после отзыва роли',async()=>{
        await expect(controller.getOperation('op-platform',request('Главный админ'))).rejects.toMatchObject({status:403});
        expect(catalog.getOperation).not.toHaveBeenCalled();
    });
    it('Актуальный главный администратор читает общую историю',async()=>{
        access.claims.mockResolvedValue({...claims,userRoles:['Главный админ']});
        await controller.getOperation('op-platform',request('Главный админ'));
        await controller.listOperations({},request('Главный админ'));
        expect(catalog.getOperation).toHaveBeenCalledWith('op-platform',undefined);
        expect(catalog.listOperations).toHaveBeenCalledWith(1,20,undefined,undefined,undefined);
    });
    it('Имя, похожее на постоянный ID, не расширяет область другого проекта',async()=>{
        access.claims.mockResolvedValue({...claims,projects:[{projectId:'prj-own',projectName:'prj-foreign',role:'Наблюдатель'}]});
        await controller.getOperation('op-foreign',request());
        expect(catalog.getOperation).toHaveBeenCalledWith('op-foreign',{projectIds:['prj-own'],actor:email});
    });
    it('Неизвестная и недоступная операция дают одинаковый 404 без private payload',async()=>{
        const scope={projectIds:['prj-own'],actor:email};
        const getOperation=vi.fn().mockResolvedValue(null);
        const service={db:{getOperation}} as unknown as CatalogService;
        for(const id of ['op-missing','op-foreign']) {
            await expect(CatalogService.prototype.getOperation.call(service,id,scope)).rejects.toMatchObject({status:404,message:`operation not found: ${id}`});
            expect(getOperation).toHaveBeenLastCalledWith(id,scope);
        }
    });
});
