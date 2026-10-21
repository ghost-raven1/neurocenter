import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {LocalAssetCards,assetCatalogLink} from '../src/features/AssetSources/LocalAssetCards';
import type {ISourceAsset} from '../src/features/AssetSources/types';

vi.mock('antd',()=>({
    Card:({children,title}:{children:React.ReactNode;title:string})=>createElement('article',null,title,children),
    Space:({children}:{children:React.ReactNode})=>children,Tag:({children}:{children:React.ReactNode})=>children,
    Typography:{Title:({children}:{children:React.ReactNode})=>createElement('h3',null,children),Text:({children}:{children:React.ReactNode})=>children,Paragraph:({children}:{children:React.ReactNode})=>createElement('p',null,children)},
    Button:({children,href,disabled}:{children:React.ReactNode;href:string;disabled?:boolean})=>createElement('a',{'aria-disabled':!!disabled,href:disabled?undefined:href},children),
}));
const asset=(changes:Partial<ISourceAsset>={}):ISourceAsset=>({id:'tool-fixture',kind:'plugin',name:'Локальная упаковка 日本語',description:'Описание',version:'build-fixture',sha256:'a'.repeat(64),license:'MIT',dependencies:[],imported:{id:'native-id',originVersion:'build-fixture',version:1,updateAvailable:false},...changes});
const render=(assets:ISourceAsset[])=>renderToStaticMarkup(createElement(LocalAssetCards,{assets,actions:()=>createElement('button',null,'Штатные действия')}));

it('Локальные упаковки показывают переход в каталог и не предлагают повторный repository-import',()=>{
    const html=render([asset()]);expect(html).toContain('Упакованные на этой площадке');expect(html).toContain('Локальная упаковка 日本語');expect(html).toContain('Открыть в каталоге');expect(html).toContain('Штатные действия');
    expect(html).not.toContain('checkbox');expect(html).not.toContain('Добавить');expect(html).toContain('href="/store?q=');
});
it.each(['archived','unavailable']as const)('Недоступный или архивный ассет %s не даёт ложную ссылку на видимую карточку',state=>{
    const html=render([asset({imported:{...asset().imported!,[state]:true}})]);expect(html).toContain('aria-disabled="true"');expect(html).not.toContain('href=');expect(html).toContain(state==='archived'?'Карточка в архиве':'Карточка временно недоступна');
});
it('Ссылка кодирует название, выбирает нужную вкладку и не теряет unicode',()=>{
    for(const [kind,tab]of [['plugin',null],['skill',null],['model','models'],['agent','agents']]as const){
        const url=new URL(assetCatalogLink(asset({kind,name:'日本語 & ?#"'})),'https://panel.fixture');expect(url.pathname).toBe('/store');expect(url.searchParams.get('q')).toBe('日本語 & ?#"');expect(url.searchParams.get('tab')).toBe(tab);
    }
});
it('Пустой поиск не рисует пустой раздел локальных упаковок',()=>{expect(render([])).toBe('');});
it('Переименование native-карточки сохраняет рабочий переход по актуальному имени',()=>{
    const renamed=asset({name:'Имя исходного ассета',imported:{...asset().imported!,name:'Новое имя в каталоге'}}),html=render([renamed]);
    expect(html).toContain('Новое имя в каталоге');expect(new URL(assetCatalogLink(renamed),'https://panel.fixture').searchParams.get('q')).toBe('Новое имя в каталоге');
});
it('Полный build hash остаётся только в закрытых сведениях, NOASSERTION не показывается как лицензия',()=>{
    const version='build-'+'a'.repeat(64),html=render([asset({version,license:'NOASSERTION'})]);
    expect(html).toContain('<details class="asset-sources__local-metadata">');expect(html).not.toContain('<details open');expect(html).not.toContain('NOASSERTION');expect(html).toContain('Не указана автором');
    const details=html.slice(html.indexOf('<details'),html.indexOf('</details>'));expect(details).toContain(version);expect(html.slice(0,html.indexOf('<details'))).not.toContain(version);
});
it('Читаемая версия и известная лицензия остаются в основном содержимом карточки',()=>{
    const html=render([asset({version:'1.2.3',license:'MIT'})]);expect(html).toContain('Версия 1.2.3');expect(html).toContain('MIT');expect(html).not.toContain('<details');
});
