import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../services/oauth2-bridge/package.json',import.meta.url));
const {SessionService}=require('../../services/oauth2-bridge/dist/auth/session.service.js');
const {AuthController}=require('../../services/oauth2-bridge/dist/auth/auth.controller.js');
const {OAuthTransactions}=require('../../services/oauth2-bridge/dist/auth/oauth-transactions.service.js');
const {loginReturn}=require('../../services/oauth2-bridge/dist/auth/login-return.js');
const {browserSecurity,allowBrowserOrigin}=require('../../services/oauth2-bridge/dist/security/browser-security.js');
const {ProxyService}=require('../../services/api-gateway/dist/proxy/proxy.service.js');
const {filterResponse}=require('../../services/api-gateway/dist/proxy/access-response.js');
const saved=process.env.SESSION_TTL_SECONDS;afterEach(()=>{if(saved===undefined){delete process.env.SESSION_TTL_SECONDS;}else{process.env.SESSION_TTL_SECONDS=saved;}});
const response=()=>({cookies:[],cleared:[],target:'',body:null,statusCode:200,headers:{},cookie(name,value,options){this.cookies.push({name,value,options});return this;},clearCookie(name){this.cleared.push(name);return this;},redirect(target){this.target=target;},json(body){this.body=body;return this;},status(code){this.statusCode=code;return this;},setHeader(name,value){this.headers[name]=value;}});
const user={email:'qa@example.test',activeRole:'Разработчик',userRoles:['Разработчик']};
test('Серверная сессия истекает даже при сохранённом клиентском cookie',t=>{
    process.env.SESSION_TTL_SECONDS='60';const sessions=new SessionService();const original=Date.now;let now=100000;t.mock.method(Date,'now',()=>now);
    const token=sessions.create(user);assert.equal(sessions.get(token),user);now+=60000;assert.equal(sessions.get(token),null);assert.equal(sessions.get(token),null);assert.ok(original()>0);
});
test('Отзыв сессии немедленно закрывает последующие запросы',()=>{const sessions=new SessionService();const token=sessions.create(user);sessions.remove(token);assert.equal(sessions.get(token),null);});
for(const value of ['0','NaN','-1','9999999']){test('Небезопасный срок сессии отклонён: '+value,()=>{process.env.SESSION_TTL_SECONDS=value;assert.throws(()=>new SessionService());});}
for(const value of ['https://attacker.example','//attacker.example','/\\attacker.example','/unknown','/projects\nbad','javascript:alert(1)']){test('Возврат после входа не перенаправляет на '+JSON.stringify(value),()=>{assert.equal(loginReturn(value),'/');});}
test('Ссылка подключения сохраняется после входа целиком',()=>{const target='/start?step=1&connect=0123456789ABCDEF';assert.equal(loginReturn(target),target);});
test('Mock-вход возвращает на подтверждение и ограничивает cookie',async()=>{
    const controller=new AuthController({ssoDisabled:true,panelUrl:'http://localhost:5173',mockUser:async()=>user},new SessionService());const res=response();
    await controller.login({query:{returnTo:'/projects?connect=0123456789ABCDEF'}},res);assert.equal(res.target,'http://localhost:5173/projects?connect=0123456789ABCDEF');assert.equal(res.cookies[0].options.httpOnly,true);assert.equal(res.cookies[0].options.secure,false);assert.ok(res.cookies[0].options.maxAge>0);
});
test('OAuth state переживает внешний SSO-переход и истекает через десять минут',async()=>{
    const transactions=new OAuthTransactions();const controller=new AuthController({ssoDisabled:false,panelUrl:'https://panel.example',authorizeUrl:state=>'https://sso.example/login?state='+state},new SessionService(),transactions);const res=response();
    await controller.login({query:{returnTo:'/start?step=1&connect=0123456789ABCDEF'}},res);const state=res.cookies.find(item=>item.name==='oauth_state');assert.equal(state.options.sameSite,'lax');assert.equal(state.options.secure,true);assert.equal(state.options.maxAge,600000);assert.equal(transactions.consume(state.value,state.value).returnTo,'/start?step=1&connect=0123456789ABCDEF');assert.equal(res.cookies.length,1);
});
test('Неверный state не обменивает код и не создаёт сессию',async()=>{
    let exchanged=false;const controller=new AuthController({ssoDisabled:false,panelUrl:'https://panel.example',exchangeCode:async()=>{exchanged=true;}},new SessionService(),new OAuthTransactions());const res=response();
    await controller.callback({cookies:{oauth_state:'correct'},query:{state:'wrong',code:'not-used'}},res);assert.equal(exchanged,false);assert.equal(res.cookies.length,0);assert.ok(res.target.endsWith('login_error=state'));
});
test('Успешный callback возвращает к подключению и очищает одноразовые cookies',async()=>{
    const transactions=new OAuthTransactions();const {state}=transactions.create('/start?step=1&connect=0123456789ABCDEF');
    const controller=new AuthController({ssoDisabled:false,panelUrl:'https://panel.example',exchangeCode:async()=>user},new SessionService(),transactions);const res=response();
    await controller.callback({cookies:{oauth_state:state,oauth_return:'https://attacker.example'},query:{state,code:'used'}},res);assert.equal(res.target,'https://panel.example/start?step=1&connect=0123456789ABCDEF');assert.deepEqual(res.cleared,['oauth_state','oauth_return']);assert.equal(res.cookies[0].options.secure,true);
});
test('Защита cookie-запросов запрещает форму и пропускает собственный интерфейс',()=>{
    for(const [custom,origin,status] of [['',undefined,403],['1','https://attacker.example',403],['1',process.env.PANEL_URL||'http://localhost:5173',200]]){
        const res=response();let next=false;browserSecurity({method:'POST',path:'/auth/switch-role',headers:{cookie:'bridge_session=test','x-neurocenter-request':custom,origin}},res,()=>{next=true;});assert.equal(res.statusCode,status);assert.equal(next,status===200);
    }
    assert.equal(allowBrowserOrigin('null'),false);assert.equal(allowBrowserOrigin(undefined),true);
});
test('Bearer-запрос MCP сохраняет контракт без браузерного заголовка',()=>{const res=response();let next=false;browserSecurity({method:'POST',path:'/api/device-channel/jobs/claim',headers:{authorization:'Bearer test'}},res,()=>{next=true;});assert.equal(next,true);});
test('Лишний Authorization не обходит защиту cookie-сессии входа',()=>{const res=response();browserSecurity({method:'POST',path:'/auth/switch-role',headers:{cookie:'bridge_session=test',authorization:'Bearer ignored',origin:'https://attacker.example'}},res,()=>assert.fail('Запрос не должен проходить'));assert.equal(res.statusCode,403);});
test('POST-выход отзывает серверный ключ и возвращает 200 вместо Nest default 201',()=>{const sessions=new SessionService();const token=sessions.create(user);const controller=new AuthController({ssoDisabled:true},sessions);const res=response();res.statusCode=201;controller.logoutJson({cookies:{bridge_session:token}},res);assert.equal(res.statusCode,200);assert.equal(sessions.get(token),null);assert.deepEqual(res.body,{});assert.ok(res.cleared.includes('bridge_session'));});
function pollGateway(){
    const proxy=new ProxyService({get:()=>undefined},{authenticate:async()=>null},{});proxy.http={post:async()=>({status:201,data:{state:'pending'}})};
    return async code=>{const res=response();await proxy.forward({method:'POST',path:'/api/device-channel/pair/poll',headers:{},socket:{remoteAddress:'test-address'},body:{deviceCode:code}},res);return res.statusCode;};
}
test('Один код ограничен по частоте и не исчерпывает ожидание другого компьютера',async()=>{
    const poll=pollGateway();for(let index=0;index<60;index++){assert.equal(await poll('a'.repeat(64)),201);}assert.equal(await poll('a'.repeat(64)),429);assert.equal(await poll('b'.repeat(64)),201);
});
test('Общий лимит сохраняется при переборе разных кодов подключения',async()=>{
    const poll=pollGateway();for(let index=0;index<6000;index++){assert.equal(await poll(index.toString(16).padStart(64,'0')),201);}assert.equal(await poll('f'.repeat(64)),429);
});
test('Список скиллов и RAG не раскрывает чужие данные при старой коллизии имени и ID',()=>{
    const claims={email:'qa@example.test',userRoles:['Админ проекта'],projects:[{projectId:'prj-own',projectName:'prj-foreign',role:'Админ проекта'}],pluginIds:[],skillPaths:[]};
    assert.deepEqual(filterResponse([{path:'project-prj-foreign/private'}],claims,'Админ проекта','/api/skills'),[]);
    assert.deepEqual(filterResponse({projects:[{projectKey:'prj-foreign'}]},claims,'Админ проекта','/api/rag/projects'),{projects:[]});
});
