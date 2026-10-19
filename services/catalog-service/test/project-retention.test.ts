import {beforeEach,describe,it,expect,vi} from 'vitest';
import {CatalogController} from '../src/catalog/catalog.controller';
import type {CatalogService} from '../src/catalog/catalog.service';
import type {AccessDb} from '../src/access/access-db';

const email='admin@example.test',id='prj-own';
const req=(activeRole='Главный админ')=>({headers:{'x-bridge-actor':encodeURIComponent(JSON.stringify({email,activeRole})), 'x-bridge-principal':'wrong@example.test'}});
let update:ReturnType<typeof vi.fn>,claims:ReturnType<typeof vi.fn>,controller:CatalogController;
beforeEach(()=>{
    update=vi.fn().mockImplementation(async(_id,body)=>({id,retention:body.retention}));
    claims=vi.fn().mockResolvedValue({email,userRoles:['Главный админ'],projects:[]});
    controller=new CatalogController({updateProject:update} as unknown as CatalogService,{claims} as unknown as AccessDb);
});

describe('Сохранение числа снимков проекта',()=>{
    it.each([undefined,null,[],42,'не объект',{},true,{retention:null},{retention:0},{retention:101},{retention:1.5},{retention:'3'},{retention:3,state:'ARCHIVED'}])('Отклоняет %j до проверки доступа и записи',async body=>{
        await expect(controller.updateRetention(id,body,req())).rejects.toMatchObject({status:400});
        expect(claims).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();
    });
    it.each([1,100])('Сохраняет границу %i и доверенного исполнителя',async retention=>{
        expect(await controller.updateRetention(id,{retention},req())).toEqual({retention});
        expect(update).toHaveBeenCalledWith(id,{retention},email);
    });
    it('Проектный администратор использует alias на основании свежих назначений',async()=>{
        claims.mockResolvedValue({email,userRoles:['Админ проекта'],projects:[{projectId:id,projectName:'Свой',role:'Админ проекта'}]});
        expect(await controller.updateRetention('Свой',{retention:9},req('Админ проекта'))).toEqual({retention:9});
        expect(update).toHaveBeenCalledWith('Свой',{retention:9},email);
    });
    it.each(['Главный админ','Админ проекта','Разработчик','Наблюдатель'])('Отозванная активная роль %s не меняет настройки',async role=>{
        claims.mockResolvedValue({email,userRoles:[],projects:[]});
        await expect(controller.updateRetention(id,{retention:9},req(role))).rejects.toMatchObject({status:403});
        expect(update).not.toHaveBeenCalled();
    });
    it('Ошибка сохранения передаётся клиенту вместо ложного успеха',async()=>{
        update.mockRejectedValue(new Error('SQL write failed'));
        await expect(controller.updateRetention(id,{retention:9},req())).rejects.toThrow('SQL write failed');
    });
});
