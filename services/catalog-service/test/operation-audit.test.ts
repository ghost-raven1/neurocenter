import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {operationAuditDetailsSql,operationAuditSnapshot} from '../src/catalog/operation-audit';
import {listAuditHistory} from '../src/catalog/audit-history';
import {ensureCatalogSchema} from '../src/database/catalog-schema';

describe('Историческая идентичность операций',()=>{
    it('Ограничивает сведения именем/типом/версией, без payload/headers/source',()=>{expect(operationAuditSnapshot({name:'Удалённый инструмент',kind:'mcp',version:2,jobKind:'install',config:{TOKEN:'secret'},files:['private'],projectName:'current renamed'})).toEqual({name:'Удалённый инструмент',kind:'mcp',version:2,jobKind:'install'});});
    it.each([null,undefined,[],{name:['bad'],kind:'x\u0000y',version:-1},{name:'x'.repeat(513)}])('Некорректный снимок %s не подменяет идентичность',value=>{expect(operationAuditSnapshot(value)).toBeNull();});
    it('SELECT берёт название удаления из receipt, а название установки из pinned package с проверкой владельца и project',()=>{expect(operationAuditDetailsSql).toContain('FROM project_retirements');expect(operationAuditDetailsSql).toContain("j.payload#>>'{package,plugin,name}'");expect(operationAuditDetailsSql).toContain('j.email=o.actor');expect(operationAuditDetailsSql).toContain('j.project_id IS NOT DISTINCT FROM o.project_id');expect(operationAuditDetailsSql).not.toMatch(/JOIN projects|FROM ai_plugins|j\.payload\s*[,)]|j\.report|headers/);});
    it('Страница аудита сохраняет whitelist и не раскрывает секреты даже из неожиданной формы operation details',async()=>{const event={id:'op',source:'operation',action:'bridge.install',resourceType:'bridge',details:{before:{private:true},after:{name:'Pinned MCP',version:3,jobKind:'install',secret:'private'}}};const query=vi.fn(async(sql:string)=>sql.includes('::int AS n')?{rows:[{n:1}]}:{rows:[event]});const result=await listAuditHistory({query}as unknown as Pool,1,20);expect(result.items[0].details).toEqual({before:null,after:{name:'Pinned MCP',jobKind:'install',version:3}});expect(JSON.stringify(result)).not.toContain('private');});
});

const connection=process.env.CATALOG_TEST_PG_URL;
describe.skipIf(!connection)('Исторические имена через actual SQL в отдельной QA базе',()=>{
    let pool:Pool,admin:Pool,name:string;
    beforeAll(async()=>{const url=new URL(connection!);if(!['127.0.0.1','localhost'].includes(url.hostname)||!url.port||url.port==='5432')throw new Error('Use an explicit disposable localhost PostgreSQL instance.');url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});name='nc_operation_audit_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;pool=new Pool({connectionString:url.href,max:2});await ensureCatalogSchema(pool);},30000);
    afterAll(async()=>{await pool?.end();if(admin&&name)await admin.query('DROP DATABASE IF EXISTS '+name);await admin?.end();},30000);
    beforeEach(async()=>{await pool.query('DELETE FROM operations');await pool.query('DELETE FROM bridge_jobs');await pool.query('DELETE FROM bridge_devices');await pool.query('DELETE FROM project_retirements');});
    const operation=async(resourceType:string,resourceId:string,actor='audit@example.test',projectId:string|null=null)=>{await pool.query(`INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state) VALUES($1,$2,$3,$4,$5,$6,'SUCCEEDED')`,[randomUUID(),resourceType==='project'?'DELETE':'INSTALL',projectId,resourceType,resourceId,actor]);};
    it('Удалённый проект показывает имя из receipt, не обращаясь к текущему проекту',async()=>{await pool.query("INSERT INTO project_retirements(project_id,project_name,actor) VALUES('prj-deleted','Имя до удаления','audit@example.test')");await operation('project','prj-deleted');expect((await listAuditHistory(pool,1,20)).items[0].details).toEqual({before:null,after:{name:'Имя до удаления'}});});
    it.each(['owner','project','missing'])('Чужое или утраченное задание %s не присваивает инструмент операции',async mismatch=>{
        const id=randomUUID();await pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES('device','audit@example.test','Главный админ','QA','fixture','fixture')");
        if(mismatch!=='missing')await pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash) VALUES($1,'device',$2,'Главный админ',$3,'install',$4,'request','hash')",[id,mismatch==='owner'?'other@example.test':'audit@example.test',mismatch==='project'?'other-project':null,{package:{plugin:{name:'Private unrelated MCP',kind:'mcp',version:2}}}]);
        await operation('bridge',id);expect((await listAuditHistory(pool,1,20)).items[0].details).toBeNull();
    });
    it('Задание возвращает только историческое pinned имя/версию без config/files/result',async()=>{const id=randomUUID();await pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES('device','audit@example.test','Главный админ','QA','fixture','fixture')");await pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash,result) VALUES($1,'device','audit@example.test','Главный админ','install',$2,'request','hash',$3)",[id,{package:{plugin:{name:'Pinned MCP',kind:'mcp',version:4},config:{headers:{Authorization:'PRIVATE'}},files:[{content:'PRIVATE'}]}},{stdout:'PRIVATE'}]);await operation('bridge',id);const result=await listAuditHistory(pool,1,20);expect(result.items[0].details).toEqual({before:null,after:{name:'Pinned MCP',kind:'mcp',version:4,jobKind:'install'}});expect(JSON.stringify(result)).not.toMatch(/PRIVATE|headers|stdout|files|config/);});
});
