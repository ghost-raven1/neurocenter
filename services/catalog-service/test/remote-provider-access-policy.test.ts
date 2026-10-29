import {describe,expect,it} from 'vitest';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';
const claims:IAccessClaims={email:'alice@test',userRoles:['Главный админ','Админ проекта','Разработчик','Наблюдатель'],projects:[],pluginIds:[],skillPaths:[]};
const route='/api/models/model-personal/my-access',key='00000000-0000-0000-0000-000000000001';
describe('personal remote provider route admission',()=>{
    it.each(['Главный админ','Админ проекта','Разработчик'])('admits declared personal operations for %s while executors enforce model ACL and self-ownership',role=>{
        for(const method of['GET','HEAD','PUT','DELETE'])expect(allowRequest(claims,role,{method,path:route})).toBe(true);
        for(const method of['GET','HEAD'])expect(allowRequest(claims,role,{method,path:route+'/requests/'+key})).toBe(true);
    });
    it('denies observer/unassigned roles and unknown methods or nested owner routes even for MainAdmin',()=>{
        for(const role of['Наблюдатель','unknown'])expect(allowRequest(claims,role,{method:'GET',path:route})).toBe(false);
        for(const method of['POST','PATCH'])expect(allowRequest(claims,'Главный админ',{method,path:route})).toBe(false);
        for(const path of[route+'/bob@test',route+'/keys',route+'/requests/not-a-uuid',route+'/requests/'+key+'/delete'])expect(allowRequest(claims,'Главный админ',{method:'GET',path})).toBe(false);
        expect(allowRequest(claims,'Главный админ',{method:'DELETE',path:route+'/requests/'+key})).toBe(false);
    });
});
