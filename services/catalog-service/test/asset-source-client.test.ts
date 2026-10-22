import { describe, expect, it, vi } from 'vitest';
import { assetDigest, serializeAsset, type AssetDescriptor, type AssetIndex } from '@neurocenter/asset-contract';
import { AssetSourceClient, validateSourcePin } from '../src/asset-sources/source-client';

const commit = 'a'.repeat(40), repository = 'ghost-raven1/neurocenter-assets' as const;
function skill(id: string, dependencies?: AssetDescriptor['dependencies']): AssetDescriptor {
    return {schemaVersion:1,id,kind:'skill',version:'1.0.0',source:{type:'release',repository:'https://github.com/example/skills',tag:'v1.0.0'},
        license:{spdx:'MIT'},compatibility:{packageFormat:5},card:{path:'common',slug:id,name:id,body:'Проверенная инструкция',meta:{description:'Инструкция для проверки'}},
        delivery:{type:'inline'},...(dependencies?{dependencies}:{})};
}
function fixture(assets: AssetDescriptor[] = [skill('helper')]) {
    const files = new Map<string,string>(), index: AssetIndex = {schemaVersion:1,assets:[]};
    for (const asset of assets) {
        const bytes = serializeAsset(asset), path = 'assets/'+asset.id+'/'+asset.version+'/asset.json'; files.set(path,bytes);
        index.assets.push({id:asset.id,kind:asset.kind,version:asset.version,path,sha256:assetDigest(bytes),current:true});
    }
    const indexBytes = JSON.stringify(index)+'\n'; files.set('index.json',indexBytes);
    const pin = {schemaVersion:1 as const,repository,commit,index:{path:'index.json',sha256:assetDigest(indexBytes)}};
    const request = vi.fn(async(url: string | URL | Request, options?: RequestInit)=>{
        expect(options?.redirect).toBe('error'); expect(options?.signal).toBeInstanceOf(AbortSignal);
        const value = String(url), prefix = `https://raw.githubusercontent.com/${repository}/${commit}/`;
        expect(value.startsWith(prefix)).toBe(true);
        const body = files.get(value.slice(prefix.length)); return new Response(body??null,{status:body===undefined?404:200});
    });
    return {pin,files,index,request,client:new AssetSourceClient(pin,request)};
}

describe('Закреплённый серверный источник ассетов',()=>{
    it('Автономный источник читает те же закреплённые байты из readonly кэша без сети',async()=>{
        const f=fixture(),bytes=new Map([...f.files.values()].map(value=>[assetDigest(value),Buffer.from(value)]));
        const request=vi.fn(async()=>{throw new Error('GitHub запрещён');});
        const client=new AssetSourceClient(f.pin,request,undefined,{offline:true,cache:{read:async sha=>bytes.get(sha)}});
        expect((await client.select(['helper'])).assets[0].asset.id).toBe('helper');expect(request).not.toHaveBeenCalled();
        bytes.delete(f.pin.index.sha256);
        await expect(client.index()).rejects.toMatchObject({status:409});expect(request).not.toHaveBeenCalled();
    });
    it('Повреждённый локальный SHA не вызывает сетевой fallback в автономном режиме',async()=>{
        const f=fixture(),request=vi.fn(async()=>new Response(f.files.get('index.json')));
        const client=new AssetSourceClient(f.pin,request,undefined,{offline:true,cache:{read:async()=>Buffer.from('damaged')}});
        await expect(client.index()).rejects.toMatchObject({status:409});expect(request).not.toHaveBeenCalled();
    });
    it('Читает exact index SHA и только выбранные описи, бинарные URL не запрашивает',async()=>{
        const f = fixture([skill('first'),skill('second')]);
        const result = await f.client.select(['second']);
        expect(result.assets.map(item=>item.asset.id)).toEqual(['second']);
        expect(f.request.mock.calls.map(([url])=>String(url).replace('https://raw.githubusercontent.com/'+repository+'/'+commit+'/',''))).toEqual(['index.json','assets/second/1.0.0/asset.json']);
    });
    it('Загружает точное замыкание в порядке зависимостей и не повторяет одинаковую опись',async()=>{
        const dependency = skill('dependency'), sha = assetDigest(serializeAsset(dependency));
        const root = skill('helper',[{id:'dependency',version:'1.0.0',sha256:sha}]);
        const f = fixture([root,dependency]);
        expect((await f.client.select(['helper','dependency'])).assets.map(item=>item.asset.id)).toEqual(['dependency','helper']);
        expect(f.request).toHaveBeenCalledTimes(3);
    });
    it.each([[],['helper','helper'],['unknown'],[1],Array.from({length:51},(_,index)=>'asset-'+index)].map(ids=>({ids})))('Отклоняет недопустимый выбор $ids',async({ids})=>{
        const f = fixture(); await expect(f.client.select(ids)).rejects.toMatchObject({status:400});
        expect(f.request).toHaveBeenCalledTimes(ids[0]==='unknown'?1:0);
    });
    it.each([
        {commit:'main'}, {repository:'https://github.com/other/repo'}, {repository:'owner/../repo'}, {repository:'owner/.'}, {repository:'owner/repo.git'}, {index:{path:'../index.json',sha256:'b'.repeat(64)}},
        {index:{path:'https://internal/index.json',sha256:'b'.repeat(64)}}, {index:{path:'/index.json',sha256:'b'.repeat(64)}},
        {index:{path:'index.json',sha256:'bad'}}, {token:'secret'},
    ])('Не принимает незакреплённый или небезопасный source pin: %j',overrides=>{
        const f = fixture(); expect(()=>validateSourcePin({...f.pin,...overrides})).toThrow();
    });
    it.each(['other/repo','other/.github','other/_bridge'])('Оператор может закрепить другой публичный GitHub-источник %s',repository=>{
        const f=fixture();expect(validateSourcePin({...f.pin,repository})).toEqual({...f.pin,repository});
    });
    it('Останавливается на изменившемся index до чтения отдельных ассетов',async()=>{
        const f = fixture(); f.files.set('index.json',f.files.get('index.json')+' ');
        await expect(f.client.select(['helper'])).rejects.toMatchObject({status:409}); expect(f.request).toHaveBeenCalledTimes(1);
    });
    it('Exact SHA учитывает завершающий перевод строки файла',async()=>{
        const f = fixture(); f.files.set('assets/helper/1.0.0/asset.json',f.files.get('assets/helper/1.0.0/asset.json')!.trimEnd());
        await expect(f.client.select(['helper'])).rejects.toThrow('SHA-256');
    });
    it('Отклоняет другой заголовок descriptor даже при совпадающем SHA файла',async()=>{
        const f = fixture(), bytes = serializeAsset(skill('other'));
        f.files.set('assets/helper/1.0.0/asset.json',bytes); f.index.assets[0].sha256 = assetDigest(bytes);
        const indexBytes = JSON.stringify(f.index); f.files.set('index.json',indexBytes);
        const client = new AssetSourceClient({...f.pin,index:{...f.pin.index,sha256:assetDigest(indexBytes)}},f.request);
        await expect(client.select(['helper'])).rejects.toThrow('не соответствует');
    });
    it('Отсутствующая и иначе закреплённая зависимость запрещают импорт до бинарников и карточек',async()=>{
        const dep = skill('dependency'), root = skill('helper',[{id:'dependency',version:'1.0.0',sha256:'b'.repeat(64)}]);
        await expect(fixture([root]).client.select(['helper'])).rejects.toThrow('отсутствует точная зависимость');
        await expect(fixture([root,dep]).client.select(['helper'])).rejects.toThrow('точная зависимость');
    });
    it('Сетевой отказ и HTTP redirect не превращаются в готовый источник',async()=>{
        const f = fixture();
        for (const request of [vi.fn(async()=>{throw new Error('PRIVATE URL');}),vi.fn(async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}))]) {
            await expect(new AssetSourceClient(f.pin,request).index()).rejects.toMatchObject({status:503});
            expect(request).toHaveBeenCalledTimes(1);
        }
    });
    it('Ограничивает размер ответа до SHA/JSON и закрывает поток',async()=>{
        const f = fixture(), cancelled = vi.fn(), stream = new ReadableStream({cancel:cancelled});
        await expect(new AssetSourceClient(f.pin,async()=>new Response(stream,{headers:{'content-length':String(513*1024)}})).index()).rejects.toThrow('размер');
        expect(cancelled).toHaveBeenCalledOnce();
    });
    it('Обрыв потока описи возвращает объяснимый отказ без частичного результата',async()=>{
        const f = fixture(), stream = new ReadableStream({start(controller){controller.error(new Error('PRIVATE transport'));}});
        await expect(new AssetSourceClient(f.pin,async()=>new Response(stream)).index()).rejects.toThrow('Передача описи прервалась');
    });
    it('HTTP gzip Content-Length описывает транспорт, SHA проверяется по распакованным байтам',async()=>{
        const f=fixture(),bytes=f.files.get('index.json')!;
        const client=new AssetSourceClient(f.pin,async()=>new Response(bytes,{headers:{'content-encoding':'gzip','content-length':'20'}}));
        expect(await client.index()).toEqual(f.index);
        await expect(new AssetSourceClient(f.pin,async()=>new Response(bytes,{headers:{'content-length':'20'}})).index()).rejects.toThrow('Размер описи');
    });
    it('Pinned recipe проверяется до результата descriptor, ошибка файла не маскируется',async()=>{
        const body='Воспроизводимый рецепт\n',asset=skill('helper');asset.recipe={path:'recipes/helper.md',sha256:assetDigest(body)};
        const f=fixture([asset]);f.files.set(asset.recipe.path,body);
        expect((await f.client.select(['helper'])).assets[0].asset.recipe).toEqual(asset.recipe);
        f.files.set(asset.recipe.path,body+'changed');
        await expect(f.client.select(['helper'])).rejects.toThrow('SHA-256');
    });
});
