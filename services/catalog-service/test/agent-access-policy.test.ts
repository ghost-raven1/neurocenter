import {describe,expect,it} from 'vitest';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';
const claims:IAccessClaims={email:'agent-policy@fixture.test',userRoles:['Главный админ','Админ проекта','Разработчик','Наблюдатель'],projects:[{projectId:'prj-own',projectName:'Own',role:'Админ проекта'}],pluginIds:[],skillPaths:[]};
const check=(role:string,method:string,path:string)=>allowRequest(claims,role,{method,path});
describe('Native agent Gateway access boundary',()=>{
 it.each(claims.userRoles)('permits scoped catalog reads for assigned role %s; AgentsService rechecks exact pins',role=>{
  for(const method of ['GET','HEAD'])for(const path of ['/api/agents','/api/agents/agent-review','/api/%61gents/%61gent-review','/api/agents/'])expect(check(role,method,path)).toBe(true);
 });
 it.each(claims.userRoles)('restricts common creation and editing to active main admin: %s',role=>{
  expect(check(role,'POST','/api/agents')).toBe(role==='Главный админ');expect(check(role,'PATCH','/api/agents/agent-review')).toBe(role==='Главный админ');
  expect(check(role,'POST','/api/%61gents')).toBe(role==='Главный админ');expect(check(role,'PATCH','/api/agents/%61gent-review')).toBe(role==='Главный админ');
 });
 it.each(['GET','HEAD','POST','PATCH','PUT','DELETE','OPTIONS'])('rejects unknown and nested routes for %s even for main admin',method=>{
  for(const path of ['/api/agents/agent-review/prompt','/api/agents/agent-review/restore','/api/agents/not-an-agent','/api/agents/%2e%2e/models','/api/agents/agent-review%2fsettings','/api/agents%2f%2fagent-review','/api/agents/%2561gent-review','/api/agents/%ZZ'])expect(check('Главный админ',method,path)).toBe(false);
 });
 it('rejects unsupported mutation methods and revoked or invented roles',()=>{
  for(const [method,path]of [['DELETE','/api/agents/agent-review'],['PUT','/api/agents/agent-review'],['POST','/api/agents/agent-review'],['PATCH','/api/agents'],['DELETE','/api/agents']])expect(check('Главный админ',method,path)).toBe(false);
  expect(allowRequest({...claims,userRoles:['Разработчик']},'Главный админ',{method:'GET',path:'/api/agents'})).toBe(false);expect(check('invented','GET','/api/agents')).toBe(false);
 });
 it('retains project-level write rules for assign/edit/connect/remove',()=>{
  for(const path of ['/api/projects/prj-own/agents','/api/projects/prj-own/agents/agent-review','/api/projects/prj-own/agents/connect']){
   for(const method of ['POST','PATCH','DELETE']){expect(check('Админ проекта',method,path)).toBe(true);for(const role of ['Разработчик','Наблюдатель'])expect(check(role,method,path)).toBe(false);}
  }
  expect(check('Админ проекта','POST','/api/projects/prj-other/agents')).toBe(false);
 });
});
