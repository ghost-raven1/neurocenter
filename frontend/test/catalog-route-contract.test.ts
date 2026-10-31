import {configureStore} from '@reduxjs/toolkit';
import {createElement,type ReactNode} from 'react';
import {Provider} from 'react-redux';
import {renderToStaticMarkup} from 'react-dom/server';
import {StaticRouter} from 'react-router-dom';
import {describe,expect,it,vi} from 'vitest';
import Router from '../src/core/routes';

vi.mock('../src/modules/Core',()=>({default:({children}:{children:ReactNode})=>children}));
vi.mock('../src/common/components/LazySection',()=>({lazySection:(_load:unknown,title:string)=>()=>createElement('p',null,title)}));

/** Exercise the actual registry/router and permission gate without loading page data or opening sockets. */
function render(path:string,permissions=['store','assets','mcp-bundles']){
    const store=configureStore({reducer:{userBlock:()=>({isAuth:true,user:{routePermissions:permissions}})}}),context:{url?:string}={};
    const html=renderToStaticMarkup(createElement(Provider,{store,children:createElement(StaticRouter,{location:path,context},createElement(Router))}));
    return {html,context};
}

describe('Active catalog route contract',()=>{
    it.each([['/store','Каталог'],['/assets','Поставка']])('Keeps %s available through its registered module', (path,title)=>{
        const result=render(path);expect(result.html).toContain(title);expect(result.html).not.toContain('Страница не найдена');expect(result.context.url).toBeUndefined();
    });
    it('A historical bundle permission does not expose the retired editor route',()=>{
        const result=render('/mcp-bundles');expect(result.html).toContain('Страница не найдена');expect(result.context.url).toBeUndefined();
    });
    it('Catalog access still requires the server-provided route permission',()=>{
        const result=render('/store',['mcp-bundles']);expect(result.context.url).toBe('/not-allowed');expect(result.html).not.toContain('Каталог');
    });
    it('Usage dashboard is registered and requires its current server permission',()=>{
        expect(render('/model-usage',['model-usage']).html).toContain('Использование моделей');
        expect(render('/model-usage',['store']).context.url).toBe('/not-allowed');
    });
    it('Usage typo alias retains query and anchor under the same route permission',()=>{
        expect(render('/modal-usage?days=30#operations',['model-usage']).context.url).toBe('/model-usage?days=30#operations');
        expect(render('/modal-usage?days=30',['store']).context.url).toBe('/not-allowed');
    });
});
