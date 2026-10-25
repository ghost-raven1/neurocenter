// Owned acceptance child: compiled classes only, no bootstrap/listener/provider exchange.
const {join,resolve}=require('node:path');
const root=resolve(process.env.BROWSER_SESSION_BUILT_ROOT||'');
if(!root.endsWith('/services/oauth2-bridge/dist'))throw new Error('Explicit owned OAuth build required');
require(require.resolve('reflect-metadata',{paths:[root]}));
const {AuthService}=require(join(root,'auth/auth.service.js'));
const {AuthController}=require(join(root,'auth/auth.controller.js'));
const {CatalogSessionClient}=require(join(root,'auth/catalog-session.client.js'));
const {SessionService}=require(join(root,'auth/session.service.js'));
const {OAuthTransactions}=require(join(root,'auth/oauth-transactions.service.js'));
const auth=new AuthService({get:key=>({SSO_DISABLE:'true',PANEL_URL:'http://panel.example'}[key])});
const sessions=new SessionService(new CatalogSessionClient());
const controller=new AuthController(auth,sessions,new OAuthTransactions());
process.on('message',async message=>{
 if(message.action==='stop'){process.disconnect();process.exit(0);return;}
 const result={status:null,cookies:[],cleared:[],redirect:null,json:null};
 const response={cookie(name,value){result.cookies.push({name,value});return this;},clearCookie(name){result.cleared.push(name);return this;},redirect(value){result.redirect=value;return this;},status(value){result.status=value;return this;},json(value){result.json=value;return this;}};
 const request={query:{},cookies:message.token?{bridge_session:message.token}:{}};
 try{
  if(message.action==='login')await controller.login(request,response);
  else if(message.action==='me')await controller.me(request,response);
  else if(message.action==='role')await controller.switchRole(request,response,{role:message.role});
  else if(message.action==='logout')await controller.logoutJson(request,response);
  else throw new Error('Unknown owned fixture action');
 }catch(error){result.status=typeof error.getStatus==='function'?error.getStatus():500;}
 process.send({id:message.id,result});
});
process.send({ready:true});
