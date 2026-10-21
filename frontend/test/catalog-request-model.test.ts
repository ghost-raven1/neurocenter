import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {requestPayload,requestEditPayload,requireRequestDetail,requireRequestPage,requireTargets} from '../src/features/CatalogRequests/model';
import {requestSourceUrl} from '../src/features/CatalogRequests/presentation';
import {createRequestKeys} from '../src/features/CatalogRequests/requestKeys';
import {readPendingCreation,savePendingCreation,clearPendingCreation,pendingCreationKey} from '../src/features/CatalogRequests/pendingCreation';
import {catalogSection,catalogSectionUrl} from '../src/modules/Store/catalogSection';
import {catalogRequest,requestDetail,requestInput} from './catalog-request-fixtures';

const records=new Map<string,string>();
beforeEach(()=>{records.clear();vi.stubGlobal('sessionStorage',{getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>records.set(key,value),removeItem:(key:string)=>records.delete(key)});});
afterEach(()=>vi.unstubAllGlobals());

describe('Контракт заявки и безопасные ссылки',()=>{
    it.each(['plugin','mcp','skill','model'] as const)('Новый %s нормализуется без скачивания',assetType=>{
        const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
        expect(requestPayload(requestInput({assetType,title:'  Название  ',description:'  Обоснование  ',target:{type:assetType,id:'ignored'}}))).toMatchObject({assetType,title:'Название',description:'Обоснование',projectId:null});
        expect(requestPayload(requestInput({assetType})).target).toBeUndefined();expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(['javascript:alert(1)','file:///private/data','https://user:password@host.test/tool','not a url'])('Неподходящая ссылка %s не принимается',value=>{expect(()=>requestSourceUrl(value)).toThrow();});
    it('Пустая ссылка необязательна; update/issue требуют карточку правильного типа',()=>{
        expect(requestSourceUrl('  ')).toBeNull();expect(requestSourceUrl('http://host.test/mcp')).toBe('http://host.test/mcp');
        for(const kind of ['update','issue'] as const){expect(()=>requestPayload(requestInput({kind}))).toThrow('карточку');expect(()=>requestPayload(requestInput({kind,target:{type:'model',id:'wrong'}}))).toThrow('карточку');}
        expect(requestEditPayload(requestInput({kind:'update',target:{type:'mcp',id:'tool'}}))).toEqual({title:'Новый MCP',description:'Для команды',sourceUrl:'https://github.com/example/tool',target:{type:'mcp',id:'tool'}});
    });
    it('Malformed page, detail or target results are failures, not empty successful UI',()=>{
        expect(()=>requireRequestPage({items:[],total:-1,page:1,size:20})).toThrow();
        expect(()=>requireRequestPage({items:[{...catalogRequest(),permissions:undefined}],total:1,page:1,size:20} as never)).toThrow();
        expect(()=>requireRequestDetail({...requestDetail(),history:undefined} as never)).toThrow();
        expect(()=>requireTargets({items:[{id:'a',name:'a',type:'other'}]} as never)).toThrow();
    });
    it('Stable request keys change only with the intent or revision',()=>{
        const keys=createRequestKeys(),first=keys.forIntent('create',requestInput());expect(keys.forIntent('create',requestInput())).toBe(first);
        expect(keys.forIntent('create',requestInput({title:'Другая'}))).not.toBe(first);expect(keys.forIntent('edit',{revision:2})).not.toBe(keys.forIntent('edit',{revision:1}));
    });
    it('Requests routing preserves project tabs and unrelated query parameters',()=>{
        expect(catalogSection('?tab=requests')).toBe('requests');expect(catalogSection('?tab=settings&catalogTab=requests',true)).toBe('requests');
        const url=new URL(catalogSectionUrl('/projects/id','?tab=catalog&p=first','requests',true,'#detail'),'https://panel.test');
        expect(url.searchParams.get('tab')).toBe('catalog');expect(url.searchParams.get('catalogTab')).toBe('requests');expect(url.hash).toBe('#detail');
    });
});

describe('Неподтверждённая отправка в хранилище вкладки',()=>{
    const value=()=>({schemaVersion:1 as const,key:crypto.randomUUID(),payload:requestInput()});
    it('Exact key and payload survive a new form instance; another access scope cannot read them',()=>{
        const original=value();savePendingCreation('author-role',original);expect(readPendingCreation('author-role')).toEqual(original);expect(readPendingCreation('other-user')).toBeNull();
        expect(()=>savePendingCreation('author-role',value())).toThrow('Сначала');expect(readPendingCreation('author-role')).toEqual(original);
    });
    it('Successful receipt clears only the matching intent',()=>{
        const original=value();savePendingCreation('author-role',original);expect(()=>clearPendingCreation('author-role','wrong')).toThrow();expect(readPendingCreation('author-role')).toEqual(original);
        clearPendingCreation('author-role',original.key);expect(readPendingCreation('author-role')).toBeNull();
    });
    it.each(['broken-json','{"schemaVersion":99}',JSON.stringify({schemaVersion:1,key:'bad',payload:requestInput()})])('Damaged storage %s fails closed without overwriting bytes',raw=>{
        records.set(pendingCreationKey('author-role'),raw);expect(()=>readPendingCreation('author-role')).toThrow('повреждена');expect(()=>savePendingCreation('author-role',value())).toThrow();expect(records.get(pendingCreationKey('author-role'))).toBe(raw);
    });
    it('Denied reads and quota errors are explicit; a later retry can recover',()=>{
        vi.stubGlobal('sessionStorage',{getItem:()=>{throw Error('blocked');}});expect(()=>readPendingCreation('a')).toThrow('хранилище');
        vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:()=>{throw Error('QuotaExceededError');}});expect(()=>savePendingCreation('a',value())).toThrow('не отправлена');
    });
});
