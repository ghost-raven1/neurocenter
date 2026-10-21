import {describe,expect,it} from 'vitest';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';
const id='11111111-1111-4111-8111-111111111111';
const claims:IAccessClaims={email:'learning-policy@fixture.test',userRoles:['Главный админ','Админ проекта','Разработчик','Наблюдатель'],projects:[{projectId:'prj-own',projectName:'Own',role:'Админ проекта'}],pluginIds:[],skillPaths:[]};
const allowed=(role:string,method:string,tail:string,project='prj-own')=>allowRequest(claims,role,{method,path:'/api/projects/'+project+'/'+tail});
describe('Project learning access policy',()=>{
 it.each(claims.userRoles)('scopes every read to a live project membership: %s',role=>{
  for(const tail of ['learning','learning/context','learning/history','learning/experiences','learning/hypotheses/'+id,'learning/requests/'+id,
   'learning/hypotheses/'+id+'/checks','learning/hypotheses/'+id+'/checks/'+id,'learning/analyses/'+id,'learning/analyses/requests/'+id]){
   expect(allowed(role,'GET',tail)).toBe(true);expect(allowed(role,'HEAD',tail)).toBe(true);
   expect(allowed(role,'GET',tail,'prj-other')).toBe(role==='Главный админ');
  }
 });
 it.each(claims.userRoles)('distinguishes reporting/review from administrator promotion: %s',role=>{
  for(const tail of ['learning/experiences','learning/hypotheses','learning/hypotheses/'+id+'/checks','learning/candidates','learning/analyses'])expect(allowed(role,'POST',tail)).toBe(role!=='Наблюдатель');
  for(const action of ['approve','reject','revoke','activate'])expect(allowed(role,'POST','learning/candidates/'+id+'/'+action)).toBe(['Главный админ','Админ проекта'].includes(role));
 });
 it('does not inherit broader project admin writes for invented routes or methods',()=>{
  for(const method of ['GET','POST','PATCH','DELETE','PUT','OPTIONS'])for(const tail of ['learning/anything','learning/analyses/'+id+'/rerun','learning/candidates/'+id+'/execute','learning/hypotheses/not-a-uuid'])expect(allowed('Главный админ',method,tail)).toBe(false);
  for(const method of ['PATCH','DELETE','PUT','OPTIONS'])expect(allowed('Главный админ',method,'learning')).toBe(false);
 });
 it('keeps the same role boundary after canonical decoding and rejects double encoding or revoked roles',()=>{
  expect(allowed('Разработчик','POST','%6cearning/hypotheses')).toBe(true);
  expect(allowed('Разработчик','POST','learning%2fcandidates/'+id+'/approve')).toBe(false);
  expect(allowed('Главный админ','POST','learning%252fcandidates/'+id+'/approve')).toBe(false);
  expect(allowRequest({...claims,userRoles:['Разработчик']},'Главный админ',{method:'POST',path:'/api/projects/prj-own/learning/analyses'})).toBe(false);
 });
});
