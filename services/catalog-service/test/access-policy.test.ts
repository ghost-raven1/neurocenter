import { describe, expect, it } from 'vitest';
import { allowRequest } from '../src/access/access-policy';
import { IAccessClaims, normalizeEmail, projectLevel } from '../src/access/access.model';
import {AccessDb} from '../src/access/access-db';
const claims:IAccessClaims={email:'member@example.test',userRoles:['Админ проекта','Разработчик','Наблюдатель'],projects:[{projectId:'prj-a',projectName:'Мой проект',role:'Админ проекта'},{projectId:'prj-b',projectName:'Другой рабочий',role:'Разработчик'},{projectId:'prj-read',projectName:'Чтение',role:'Наблюдатель'}],pluginIds:['approved'],skillPaths:['common/approved']};
const request=(method:string,path:string,body?:Record<string,unknown>,query?:Record<string,unknown>)=>({method,path,body,query});
describe('Единая ролевая модель каталога',()=>{
    it('Лимиты каждой модели изменяет главный админ; проектный админ только читает',()=>{
        const path='/api/models/model-test/rate-limit',main={...claims,userRoles:['Главный админ']};
        expect(allowRequest(main,'Главный админ',request('PUT',path))).toBe(true);
        expect(allowRequest(claims,'Админ проекта',request('GET',path))).toBe(true);
        expect(allowRequest(claims,'Админ проекта',request('PUT',path))).toBe(false);
        for(const role of ['Разработчик','Наблюдатель'])expect(allowRequest(claims,role,request('GET',path))).toBe(false);
        expect(allowRequest(main,'Главный админ',request('DELETE',path))).toBe(false);
    });
    it('Источники и private traces чата читаются рабочей ролью, неизвестные маршруты не расширяют policy',()=>{
        const id='a'.repeat(8)+'-'+ 'a'.repeat(4)+'-'+ 'a'.repeat(4)+'-'+ 'a'.repeat(4)+'-'+ 'a'.repeat(12);
        for(const path of ['/api/model-chats/research-tools',`/api/model-chats/${id}/research-tools`,`/api/model-chats/${id}/research-steps/${id}`]){
            expect(allowRequest(claims,'Разработчик',request('GET',path))).toBe(true);
            expect(allowRequest(claims,'Наблюдатель',request('GET',path))).toBe(false);
            expect(allowRequest(claims,'Разработчик',request('POST',path))).toBe(false);
        }
        expect(allowRequest(claims,'Разработчик',request('GET',`/api/model-chats/${id}/research-steps/secret`))).toBe(false);
    });
    it('Контракт полного пакета сохраняет права на исходный скилл и не расширяет запись',()=>{
        for(const role of claims.userRoles){
            expect(allowRequest(claims,role,request('GET','/api/skills/_package/project-prj-a/helper'))).toBe(true);
            expect(allowRequest(claims,role,request('GET','/api/skills/_package/project-prj-stranger/private'))).toBe(false);
            expect(allowRequest(claims,role,request('GET','/api/skills/_package/common/approved'))).toBe(true);
        }
        expect(allowRequest(claims,'Разработчик',request('PUT','/api/skills/_package/project-prj-a/helper'))).toBe(false);
    });
    it('Даже старое имя, совпадающее с чужим ID, не становится назначением на него',()=>{
        const collision={...claims,projects:[{projectId:'prj-own',projectName:'prj-foreign',role:'Админ проекта'}]};
        expect(projectLevel(collision,'Админ проекта','prj-own')).toBe(3);
        expect(projectLevel(collision,'Админ проекта','prj-foreign')).toBe(0);
        expect(allowRequest(collision,'Админ проекта',request('GET','/api/skills/project-prj-foreign/private'))).toBe(false);
        expect(allowRequest(collision,'Админ проекта',request('PUT','/api/skills/project-prj-foreign/private'))).toBe(false);
    });
    it('Локальные серверные конфигурации недоступны наблюдателю и разработчику',()=>{
        for(const role of ['Наблюдатель','Разработчик']){
            expect(allowRequest(claims,role,request('GET','/api/local-assets/scan'))).toBe(false);
        }
    });
    it('Не назначенная роль не даёт доступа даже при явной передаче в запросе',()=>{
        expect(allowRequest(claims,'Главный админ',request('GET','/api/projects'))).toBe(false);
        expect(projectLevel(claims,'Главный админ','prj-a')).toBe(0);
    });
    it('Роль администратора проекта ограничена его назначениями',()=>{
        expect(allowRequest(claims,'Админ проекта',request('PATCH','/api/projects/prj-a'))).toBe(true);
        expect(allowRequest(claims,'Админ проекта',request('PATCH','/api/projects/prj-b'))).toBe(false);
        expect(allowRequest(claims,'Админ проекта',request('GET','/api/projects/prj-stranger'))).toBe(false);
    });
    it('Выбор наблюдателя снижает права даже в администрируемом проекте',()=>{
        expect(allowRequest(claims,'Наблюдатель',request('GET','/api/projects/prj-a'))).toBe(true);
        expect(allowRequest(claims,'Наблюдатель',request('POST','/api/projects/prj-a/assets'))).toBe(false);
    });
    it('Разработчик устанавливает разрешённое, но не меняет состав проектного каталога',()=>{
        expect(allowRequest(claims,'Разработчик',request('POST','/api/local-assets/install',{projectName:'prj-b'}))).toBe(true);
        expect(allowRequest(claims,'Разработчик',request('POST','/api/projects/prj-b/assets'))).toBe(false);
    });
    it('Глобальное администрирование недоступно администратору проекта',()=>{
        for(const path of ['/api/platform/users','/api/maintenance/backup','/api/audit']) {
            expect(allowRequest(claims,'Админ проекта',request('GET',path))).toBe(false);
        }
        expect(allowRequest(claims,'Админ проекта',request('POST','/api/ai-plugins'))).toBe(false);
    });
    it('Нельзя назначить администратора без системного права',()=>{
        expect(allowRequest(claims,'Админ проекта',request('POST','/api/projects/prj-a/members',{role:'Админ проекта'}))).toBe(false);
    });
    it('Прямое чтение чужих данных RAG запрещено',()=>{
        for(const path of ['manifest','chunks','summary','size','quota']) {
            expect(allowRequest(claims,'Наблюдатель',request('GET',`/api/rag/${path}`,undefined,{projectKey:'prj-stranger'}))).toBe(false);
            expect(allowRequest(claims,'Наблюдатель',request('GET',`/api/rag/${path}`,undefined,{projectKey:'prj-a'}))).toBe(true);
        }
    });
    it('Лимит знаний меняет только администратор выбранного проекта с активной ролью',()=>{
        const patch=(key:string)=>request('PATCH','/api/rag/quota',{projectKey:key,limitBytes:1000,expectedRevision:0,actor:'forged@example.test'});
        expect(allowRequest(claims,'Админ проекта',patch('prj-a'))).toBe(true);
        for(const role of ['Разработчик','Наблюдатель']){expect(allowRequest(claims,role,patch('prj-a'))).toBe(false);}
        for(const key of ['prj-b','prj-read','prj-stranger']){expect(allowRequest(claims,'Админ проекта',patch(key))).toBe(false);}
        expect(allowRequest({...claims,userRoles:['Главный админ']},'Главный админ',patch('prj-stranger'))).toBe(true);
    });
    it('Наблюдателю доступны только утверждённые общие инструменты и его проектные скиллы',()=>{
        expect(allowRequest(claims,'Наблюдатель',request('GET','/api/ai-plugins/approved/package'))).toBe(true);
        expect(allowRequest(claims,'Наблюдатель',request('GET','/api/ai-plugins/secret/package'))).toBe(false);
        expect(allowRequest(claims,'Наблюдатель',request('GET','/api/skills/common/approved'))).toBe(true);
        expect(allowRequest(claims,'Наблюдатель',request('GET','/api/skills/project-prj-stranger/private'))).toBe(false);
    });
    it('Доступ главного администратора действует во всех проектах',()=>{
        const main={...claims,userRoles:['Главный админ']};
        expect(allowRequest(main,'Главный админ',request('PATCH','/api/projects/any-project'))).toBe(true);
        expect(allowRequest(main,'Главный админ',request('POST','/api/platform/users'))).toBe(true);
    });
    it('Неизвестные роли и маршруты запрещены по умолчанию',()=>{
        expect(projectLevel(claims,'admin','prj-a')).toBe(0);
        expect(allowRequest(claims,'Админ проекта',request('GET','/api/unknown'))).toBe(false);
    });
    it.each(['PUT','DELETE'])('Тело %s не подменяет путь защищённого скилла из URL',method=>{
        expect(allowRequest(claims,'Разработчик',request(method,'/api/skills/common/secret',{path:'project-prj-b/allowed'}))).toBe(false);
        expect(allowRequest(claims,'Разработчик',request(method,'/api/skills/project-prj-stranger/secret',{path:'project-prj-b/allowed'}))).toBe(false);
        expect(allowRequest(claims,'Разработчик',request(method,'/api/skills/project-prj-b/allowed',{path:'common'}))).toBe(true);
    });
    it('Путь тела используется для создания скилла, где URL ещё не содержит его имени',()=>{
        expect(allowRequest(claims,'Разработчик',request('POST','/api/skills',{path:'project-prj-b',slug:'helper'}))).toBe(true);
        expect(allowRequest(claims,'Разработчик',request('POST','/api/skills',{path:'common',slug:'helper'}))).toBe(false);
    });
    it('Почта нормализуется, произвольный логин не принимается',()=>{
        expect(normalizeEmail(' User@Example.test ')).toBe('user@example.test');
        expect(()=>normalizeEmail('username')).toThrow();
    });
});

describe('Источник системных прав пользователя',()=>{
    it.each([false,true])('Главный админ зависит только от platform_users.is_main_admin=%s',async isMainAdmin=>{
        const access=Object.create(AccessDb.prototype) as AccessDb;
        Object.defineProperty(access,'pool',{value:{query:async(sql:string)=>({rows:sql.includes('FROM platform_users')
            ?[{is_main_admin:isMainAdmin,enabled:true}]:sql.includes('FROM project_members')
            ?[{projectId:'prj-malformed',projectName:'Legacy assignment',role:'Главный админ'}]:[]})}});
        const current=await access.claims('member@example.test');
        expect(current.userRoles.includes('Главный админ')).toBe(isMainAdmin);
        expect(allowRequest(current,'Главный админ',request('POST','/api/ai-plugins'))).toBe(isMainAdmin);
    });
});
