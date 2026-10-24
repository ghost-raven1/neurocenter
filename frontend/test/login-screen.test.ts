import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import LoginScreen from '../src/features/UserBlock/LoginScreen';
import {authLoginBlitz} from '../src/features/UserBlock/redux/actions';

const view=vi.hoisted(()=>({processing:false,error:'',button:{} as any}));
vi.mock('react-redux',()=>({useSelector:()=>({processing:view.processing,error:view.error})}));
vi.mock('../src/features/UserBlock/redux/actions',()=>({authLoginBlitz:vi.fn()}));
vi.mock('antd',()=>{
    const content=({children}:{children?:ReactNode})=>children;
    return {Card:content,Typography:{Text:content,Title:content,Paragraph:content},
        Alert:({message,role}:any)=>createElement('aside',{role},message),
        Button:(props:any)=>{view.button=props;return createElement('button',{disabled:props.loading},props.children);}};
});
beforeEach(()=>{view.processing=false;view.error='';vi.clearAllMocks();});
describe('Login redesign preserves the existing authentication action and feedback',()=>{
    it('Offers one sign-in action and keeps decorative vectors outside the accessible content',()=>{
        const html=renderToStaticMarkup(createElement(LoginScreen));
        expect(html).toContain('Войти в Нейроцентр');expect(html.match(/<button/g)).toHaveLength(1);
        expect(html).toContain('/brand-mark.svg');expect(html).toContain('aria-hidden="true"');
        view.button.onClick();expect(authLoginBlitz).toHaveBeenCalledOnce();
    });
    it('Retains processing and exposes a failed sign-in as an alert without removing retry',()=>{
        view.processing=true;renderToStaticMarkup(createElement(LoginScreen));expect(view.button.loading).toBe(true);
        view.processing=false;view.error='Сервис входа недоступен';
        const html=renderToStaticMarkup(createElement(LoginScreen));
        expect(html).toContain('role="alert"');expect(html).toContain(view.error);expect(html.match(/<button/g)).toHaveLength(1);expect(view.button.loading).toBe(false);
        view.button.onClick();expect(authLoginBlitz).toHaveBeenCalledOnce();
    });
});
