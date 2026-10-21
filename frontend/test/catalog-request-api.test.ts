import {beforeEach,describe,expect,it,vi} from 'vitest';
import base from '../src/core/api/base';
import {catalogRequestsApi} from '../src/features/CatalogRequests/api';
import {requestInput} from './catalog-request-fixtures';
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),post:vi.fn(),patch:vi.fn()}}));
beforeEach(()=>{vi.clearAllMocks();for(const method of [base.get,base.post,base.patch])vi.mocked(method).mockResolvedValue({data:{}});});
describe('Заявки используют общий session/CSRF client и точные ID',()=>{
    it('Scope, server filters and pagination pass through without client-wide catalog fetches',async()=>{
        const filters={scope:'all' as const,kind:'issue' as const,assetType:'model' as const,projectId:'prj/one',status:'needs_info' as const,page:2,size:20};
        await catalogRequestsApi.list(filters);await catalogRequestsApi.get('id/one');await catalogRequestsApi.targets('skill','prj/one','проверка');
        expect(base.get).toHaveBeenCalledWith('/api/catalog-requests',{params:filters});expect(base.get).toHaveBeenCalledWith('/api/catalog-requests/id%2Fone');
        expect(base.get).toHaveBeenCalledWith('/api/catalog-requests/targets',{params:{assetType:'skill',projectId:'prj/one',q:'проверка',limit:100}});expect(base.post).not.toHaveBeenCalled();
    });
    it('Create key, edit CAS and review CAS are sent explicitly',async()=>{
        await catalogRequestsApi.create(requestInput(),'create-key');await catalogRequestsApi.edit('id/one',{title:'Новое',description:'Текст'},4,'edit-key');await catalogRequestsApi.action('id/one',{action:'complete',comment:'Готово',target:{type:'mcp',id:'catalog-1'}},5,'action-key');
        expect(base.post).toHaveBeenCalledWith('/api/catalog-requests',{...requestInput(),requestKey:'create-key'});
        expect(base.patch).toHaveBeenCalledWith('/api/catalog-requests/id%2Fone',{title:'Новое',description:'Текст',expectedRevision:4,requestKey:'edit-key'});
        expect(base.post).toHaveBeenCalledWith('/api/catalog-requests/id%2Fone/actions',{action:'complete',comment:'Готово',target:{type:'mcp',id:'catalog-1'},expectedRevision:5,requestKey:'action-key'});
    });
});
