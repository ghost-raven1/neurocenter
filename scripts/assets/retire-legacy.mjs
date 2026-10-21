import {fileURLToPath} from 'node:url';
import path from 'node:path';

/** Explicit operator preview/apply; identities and file paths come only from the server's audited policy. */
export function parseRetirementArguments(args){
    if(args.includes('--help'))return {help:true};
    const [mode,...flags]=args;if(!['preview','apply'].includes(mode))throw Error('Команды: preview | apply --preview-id UUID --digest SHA256 --request-key UUID');
    const options={mode},keys={'--url':'url','--preview-id':'previewId','--digest':'expectedDigest','--request-key':'requestKey'};
    for(let n=0;n<flags.length;n++){const key=keys[flags[n]];if(!key||options[key]!==undefined||!flags[n+1]||flags[n+1].startsWith('--'))throw Error('Некорректный или повторный параметр миграции.');options[key]=flags[++n];}
    if(mode==='preview'&&['previewId','expectedDigest','requestKey'].some(k=>options[k]!==undefined))throw Error('Сначала получите актуальный preview без параметров изменения.');
    if(mode==='apply'&&(!/^[a-f0-9]{64}$/.test(options.expectedDigest??'')||['previewId','requestKey'].some(k=>!(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(options[k]??'')))))throw Error('Для apply нужны preview-id, SHA256 digest и UUID request-key.');
    return options;
}
export async function runRetirement(args=process.argv.slice(2),request=fetch,environment=process.env){
    const options=parseRetirementArguments(args);if(options.help)return {usage:'preview [--url ORIGIN] | apply --preview-id UUID --digest SHA256 --request-key UUID [--url ORIGIN]'};
    const base=new URL(options.url??environment.NEUROCENTER_URL??'http://localhost:5173'),local=['localhost','127.0.0.1','[::1]'].includes(base.hostname);
    if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||local&&base.protocol==='http:'))throw Error('Укажите origin HTTPS либо локального сервера без пути и credentials.');
    let cookie=environment.NEUROCENTER_OPERATOR_COOKIE??'';
    if(!cookie){
        if(!local)throw Error('Для удалённого сервера передайте действующую operator session через NEUROCENTER_OPERATOR_COOKIE.');
        const login=await request(new URL('/auth/login',base),{redirect:'manual',signal:AbortSignal.timeout(10000)});
        cookie=login.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');if(!cookie)throw Error('Локальный вход не подтвердил сессию главного администратора.');
    }
    const headers={cookie,'content-type':'application/json','X-Neurocenter-Request':'1'};
    const me=await request(new URL('/auth/me',base),{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!me.ok||(await me.json()).user?.activeRole!=='Главный админ')throw Error('Нужна действующая сессия главного администратора.');
    const body=options.mode==='preview'?{}:{previewId:options.previewId,expectedDigest:options.expectedDigest,requestKey:options.requestKey};
    const response=await request(new URL('/api/asset-management/legacy-retirement/'+options.mode,base),{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(120000),body:JSON.stringify(body)});
    let result;try{result=await response.json();}catch{throw Error('Сервер не подтвердил JSON-квитанцию. При apply повторите прежний request-key.');}
    if(!response.ok)throw Error(`HTTP ${response.status}: ${typeof result.message==='string'?result.message.slice(0,300):'Запрос не подтверждён. Повтор apply сохраняет прежний request-key.'}`);
    return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    try{const result=await runRetirement();console.log(JSON.stringify(result,null,2));if(process.argv[2]==='apply'&&result.state!=='SUCCEEDED')process.exitCode=2;}catch(error){console.error(error.message);process.exitCode=1;}
}
