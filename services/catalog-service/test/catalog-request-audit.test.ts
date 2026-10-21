import {describe,expect,it} from 'vitest';
import {isRequestAudit,requestAuditSnapshot} from '../src/catalog-requests/request.audit';

describe('Catalog request metadata in shared audit',()=>{
    it('keeps decision metadata while dropping private request content',()=>{
        const result=requestAuditSnapshot({id:'request-fixture',title:'Проверить MCP',kind:'issue',assetType:'mcp',projectId:null,status:'completed',revision:4,
            description:'PRIVATE_DESCRIPTION',sourceUrl:'https://private.example.test',comment:'PRIVATE_COMMENT',payload:{credential:'PRIVATE_KEY'}});
        expect(result).toEqual({id:'request-fixture',title:'Проверить MCP',kind:'issue',assetType:'mcp',projectId:null,status:'completed',revision:4});
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private\.example/);
    });
    it('rejects malformed metadata and does not invent revisions',()=>{
        expect(requestAuditSnapshot(['PRIVATE_DESCRIPTION'])).toBeNull();
        expect(requestAuditSnapshot({title:{private:'value'},revision:'4',projectId:[],status:()=>undefined})).toEqual({});
        expect(requestAuditSnapshot({revision:-1})).toEqual({});
    });
    it('exposes only the supported intake actions',()=>{
        expect(isRequestAudit('catalog_request.needs_info')).toBe(true);
        expect(isRequestAudit('catalog_request.toString')).toBe(false);
        expect(isRequestAudit('catalog_request.unknown')).toBe(false);
        expect(isRequestAudit('plugin.create')).toBe(false);
    });
});
