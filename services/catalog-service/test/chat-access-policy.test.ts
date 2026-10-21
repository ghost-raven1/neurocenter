import {describe,expect,it} from 'vitest';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';
const id='12345678-1234-4234-8234-123456789abc',base='/api/model-chats',chat=base+'/'+id;
const claims:IAccessClaims={email:'test@example.com',userRoles:['Главный админ','Админ проекта','Разработчик','Наблюдатель'],projects:[],pluginIds:[],skillPaths:[]};
describe('Personal chat route permissions',()=>{
    it.each(['Главный админ','Админ проекта','Разработчик'])('allows only declared operations for %s before per-resource ownership checks',role=>{
        const routes=[['GET',base],['POST',base],['GET',chat],['PATCH',chat],['DELETE',chat],['POST',chat+'/attachments'],['GET',chat+'/attachments/'+id],['DELETE',chat+'/attachments/'+id],['POST',chat+'/context-preview'],['POST',chat+'/turns'],['POST',chat+'/turns/'+id+'/retry'],['POST',chat+'/turns/'+id+'/cancel'],['DELETE',chat+'/turns/'+id]];
        routes.push(['GET',chat+'/history'],['HEAD',chat+'/history']);
        for(const [method,path] of routes)expect(allowRequest(claims,role,{method,path})).toBe(true);
    });
    it('rejects observers and unassigned roles even on reads',()=>{for(const role of ['Наблюдатель','unknown'])expect(allowRequest(claims,role,{method:'GET',path:base})).toBe(false);});
    it('does not grant unknown suffixes, malformed paths or unsupported verbs',()=>{
        for(const path of [base+'/admin',chat+'/keys',chat+'/turns/'+id+'/unknown',chat+'/attachments/'+id+'/content',chat+'%252fturns',base+'-other'])expect(allowRequest(claims,'Главный админ',{method:'POST',path})).toBe(false);
        for(const method of ['PUT','DELETE','PATCH'])expect(allowRequest(claims,'Разработчик',{method,path:base})).toBe(false);
        expect(allowRequest(claims,'Разработчик',{method:'POST',path:chat+'/history'})).toBe(false);
    });
});
