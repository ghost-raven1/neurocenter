import {describe,expect,it} from 'vitest';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';

describe('Права шлюза на флаги платформы',()=>{
    const claims:IAccessClaims={email:'reader@example.test',userRoles:['Наблюдатель','Главный админ'],projects:[],pluginIds:[],skillPaths:[]};
    it('Текущие значения доступны назначенной роли без права управления',()=>{
        expect(allowRequest(claims,'Наблюдатель',{method:'GET',path:'/api/feature-flags/evaluated'})).toBe(true);
        expect(allowRequest(claims,'Наблюдатель',{method:'PATCH',path:'/api/feature-flags/evaluated'})).toBe(false);
        expect(allowRequest(claims,'Наблюдатель',{method:'GET',path:'/api/feature-flags'})).toBe(false);
        expect(allowRequest(claims,'Наблюдатель',{method:'PATCH',path:'/api/feature-flags/model_hosting'})).toBe(false);
    });
    it('Главный администратор управляет флагами, отзыв роли действует немедленно',()=>{
        const route={method:'PATCH',path:'/api/feature-flags/model_hosting'};
        expect(allowRequest(claims,'Главный админ',route)).toBe(true);
        expect(allowRequest({...claims,userRoles:['Наблюдатель']},'Главный админ',route)).toBe(false);
    });
});
