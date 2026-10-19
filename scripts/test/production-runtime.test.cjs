const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {loadSecrets,validateProduction}=require('../../services/shared/runtime.cjs');

const auth=()=>({NODE_ENV:'production',SSO_DISABLE:'false',PANEL_URL:'https://panel.example.test',SSO_HOST:'https://sso.example.test',
    REDIRECT_URI:'https://panel.example.test/auth/callback',SSO_CLIENT_ID:'production-client',SSO_CLIENT_SECRET:'test-only-secret',NEUROCENTER_INTERNAL_TOKEN:'a'.repeat(64)});
test('Полный HTTPS-конфиг Blitz принимается',()=>assert.doesNotThrow(()=>validateProduction(auth(),'oauth2-bridge')));
test('Слабый секрет метрик отклонён, отсутствие секрета оставляет endpoint закрытым',()=>{
    assert.throws(()=>validateProduction({...auth(),NEUROCENTER_METRICS_TOKEN:'weak'},'oauth2-bridge'),/NEUROCENTER_METRICS_TOKEN/);
    assert.doesNotThrow(()=>validateProduction({...auth(),NEUROCENTER_METRICS_TOKEN:'b'.repeat(64)},'oauth2-bridge'));
});
test('Каталог production требует явный адрес сервиса скиллов вместо локального fallback',()=>{
    const env={...auth(),CATALOG_PG_URL:'postgresql://catalog:fixture@postgres/catalog',RAG_PG_URL:'postgresql://backup:fixture@postgres/rag'};
    assert.throws(()=>validateProduction(env,'catalog-service'),/SKILLS_SERVICE_URL/);
    assert.doesNotThrow(()=>validateProduction({...env,SKILLS_SERVICE_URL:'http://skills-service:4200'},'catalog-service'));
    for(const value of ['file:///tmp/skills','http://user:secret@skills-service:4200','http://skills-service:4200/private']){
        assert.throws(()=>validateProduction({...env,SKILLS_SERVICE_URL:value},'catalog-service'),error=>error.message.includes('SKILLS_SERVICE_URL')&&!error.message.includes('user:secret'));
    }
});
for(const key of ['PANEL_URL','SSO_HOST','REDIRECT_URI','SSO_CLIENT_ID','SSO_CLIENT_SECRET','NEUROCENTER_INTERNAL_TOKEN']){
    test('Незаполненный '+key+' запрещает запуск до Nest и БД',()=>{const env=auth();env[key]='';assert.throws(()=>validateProduction(env,'oauth2-bridge'),new RegExp(key));});
}
for(const flag of ['SSO_DISABLE','RAG_AUTH_DISABLED']){test('Dev-обход '+flag+' не проходит в production',()=>{const env=auth();env[flag]='true';assert.throws(()=>validateProduction(env,'oauth2-bridge'),new RegExp(flag));});}
test('Чужой callback и отключённый TLS отклоняются',()=>{
    assert.throws(()=>validateProduction({...auth(),REDIRECT_URI:'https://other.example.test/auth/callback'},'oauth2-bridge'));
    assert.throws(()=>validateProduction({...auth(),NODE_TLS_REJECT_UNAUTHORIZED:'0'},'oauth2-bridge'));
});
for(const value of ['http://panel.example.test','https://user:secret@panel.example.test','https://panel.example.test/subpath']){
    test('Неподходящий публичный URL отклонён без раскрытия значения',()=>assert.throws(()=>validateProduction({...auth(),PANEL_URL:value},'oauth2-bridge'),error=>!error.message.includes('user:secret')));
}
test('Секрет читается из файла, неоднозначный источник отвергается',()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nc-runtime-'));const file=path.join(directory,'secret');
    try{fs.writeFileSync(file,'private-test-value\n',{mode:0o600});const env={SSO_CLIENT_SECRET_FILE:file};loadSecrets(env);assert.equal(env.SSO_CLIENT_SECRET,'private-test-value');assert.throws(()=>loadSecrets(env),/только/);}
    finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('Неизвестный сервис и слабый внутренний ключ отвергаются',()=>{
    assert.throws(()=>validateProduction(auth(),'unknown'));
    assert.throws(()=>validateProduction({...auth(),NEUROCENTER_INTERNAL_TOKEN:'short'},'oauth2-bridge'));
});
test('Bootstrap требует только своё подключение и не получает SSO-секрет',()=>{
    assert.doesNotThrow(()=>validateProduction({NODE_ENV:'production',CATALOG_PG_URL:'postgresql://runtime:test@postgres/catalog'},'bootstrap-admin'));
});
