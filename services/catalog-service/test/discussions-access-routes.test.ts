import {expect,it} from 'vitest';
import {allowRequest} from '../src/access/access-policy';
import type {IAccessClaims} from '../src/access/access.model';
const id='01234567-89ab-4cde-8f01-23456789abcd';
const claims:IAccessClaims={email:'reader@example.test',userRoles:['Наблюдатель'],projects:[],pluginIds:[],skillPaths:[]};

it('admits exact discussion methods for a currently assigned role, leaving object ACL to the executor',()=>{
 for(const[method,path]of [['GET','/api/help'],['HEAD','/api/help/getting-started'],['GET','/api/discussions'],['POST','/api/discussions/comments'],['PATCH','/api/discussions/comments/'+id],['DELETE','/api/discussions/comments/'+id],['POST','/api/discussions/attachments'],['HEAD','/api/discussions/attachments/'+id+'/content'],['DELETE','/api/discussions/attachments/'+id],['PUT','/api/catalog-reactions'],['DELETE','/api/catalog-reactions']]){
  expect(allowRequest(claims,'Наблюдатель',{method,path})).toBe(true);expect(allowRequest(claims,'Главный админ',{method,path})).toBe(false);
 }
});
it('permits Markdown writes only by an assigned main administrator and denies unknown actions',()=>{
 expect(allowRequest(claims,'Наблюдатель',{method:'PUT',path:'/api/help/getting-started'})).toBe(false);
 const main={...claims,userRoles:['Главный админ']};expect(allowRequest(main,'Главный админ',{method:'PUT',path:'/api/help/getting-started'})).toBe(true);
 for(const[method,path]of [['DELETE','/api/help/getting-started'],['POST','/api/help'],['PUT','/api/discussions'],['DELETE','/api/discussions'],['PATCH','/api/catalog-reactions'],['POST','/api/discussions/comments/'+id+'/restore'],['GET','/api/discussions/attachments/'+id],['PUT','/api/discussions/attachments']])expect(allowRequest(main,'Главный админ',{method,path})).toBe(false);
});
