import {describe,it,expect} from 'vitest';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';

describe('Method receipt history keeps the room executor ACL and read-only route boundary',()=>{
    const message='00000000-0000-4000-8000-000000000002',room='00000000-0000-4000-8000-000000000001';
    const claims:IAccessClaims={email:'reader@example.test',userRoles:['Наблюдатель'],projects:[{projectId:'prj-qa',projectName:'QA',role:'Наблюдатель'}],pluginIds:[],skillPaths:[]};
    for(const path of [`/api/projects/prj-qa/team-chat/messages/${message}/workflows`,`/api/projects/prj-qa/team-chat/rooms/${room}/messages/${message}/workflows`]){
        it(`allows bounded history reads but no mutation: ${path}`,()=>{
            for(const method of ['GET','HEAD'])expect(allowRequest(claims,'Наблюдатель',{method,path})).toBe(true);
            for(const method of ['POST','PUT','DELETE'])expect(allowRequest(claims,'Наблюдатель',{method,path})).toBe(false);
            expect(allowRequest({...claims,projects:[]},'Наблюдатель',{method:'GET',path})).toBe(false);
        });
    }
});
