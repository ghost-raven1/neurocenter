import fs from 'node:fs';
import path from 'node:path';
import {decorators,nestBindings,values} from './typescript.mjs';

export const SERVICES=['catalog-service','skills-service','rag-sync-service','feature-flags-service','oauth2-bridge','api-gateway'];
const HTTP=new Map([['Get','get'],['Post','post'],['Put','put'],['Patch','patch'],['Delete','delete'],['Head','head'],['Options','options'],['All','all']]);

export function controllerFiles(root){
    const result=[];
    const walk=directory=>{if(!fs.existsSync(directory))return;for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        const file=path.join(directory,item.name);if(item.isDirectory())walk(file);else if(item.name.endsWith('.controller.ts'))result.push(file);
    }};
    for(const service of SERVICES)walk(path.join(root,'services',service,'src'));
    return result;
}

/** Express optional groups become separate valid OpenAPI paths, whose path parameters stay required. */
export function normalizePaths(raw){
    let paths=[raw.replace(/\/+/g,'/').replace(/^\/?/,'/')];
    while(paths.some(item=>item.includes('{'))){
        paths=paths.flatMap(item=>{const match=/\{([^{}]*)\}/.exec(item);return match?[item.slice(0,match.index)+item.slice(match.index+match[0].length),item.slice(0,match.index)+match[1]+item.slice(match.index+match[0].length)]:[item];});
    }
    return [...new Set(paths.map(item=>item.replace(/:([A-Za-z_][\w]*)/g,'{$1}').replace(/\*([A-Za-z_][\w]*)/g,'{$1}').replace(/\/$/,'')||'/'))];
}

function deviceRules(ts,root){
    const filename=path.join(root,'services/api-gateway/src/proxy/proxy.service.ts');
    if(!fs.existsSync(filename))return ()=>false;
    const source=ts.createSourceFile(filename,fs.readFileSync(filename,'utf8'),ts.ScriptTarget.Latest,true),rules=[];
    const scan=node=>{
        if(ts.isRegularExpressionLiteral(node)){
            const text=node.text,last=text.lastIndexOf('/'),pattern=text.slice(1,last);
            if(pattern.startsWith('^')&&(pattern.includes('pair\\/')||pattern.includes('identity|heartbeat')||pattern.includes('runtime\\/'))){rules.push(new RegExp(pattern,text.slice(last+1)));}
        }
        ts.forEachChild(node,scan);
    };scan(source);
    return (method,suffix)=>{
        const sample=suffix.replace(/:[A-Za-z_]\w*/g,name=>name.includes('sha')?'a'.repeat(64):'a'.repeat(8)+'-'+('a'.repeat(4)+'-').repeat(3)+'a'.repeat(12));
        return rules.some(rule=>rule.test(sample)&&(method==='get'?sample.includes('/runtime/'):method==='post'&&!sample.includes('/runtime/')));
    };
}

function publicPath(service,method,raw,device){
    const clean='/'+raw.split('/').filter(Boolean).join('/');
    if(service==='catalog-service'&&clean.startsWith('/internal/device-channel/')){
        const suffix=clean.slice('/internal/device-channel/'.length);return device(method,suffix)?'/api/device-channel/'+suffix:null;
    }
    if(clean.startsWith('/internal')||clean==='/health'||clean==='/ready'||clean==='/metrics')return null;
    if(service==='oauth2-bridge')return clean.startsWith('/auth/')?clean:null;
    if(!clean.startsWith('/api/'))return null;
    if(service==='api-gateway')return clean;
    const upstream=/^\/api\/feature-flags(?:\/|$)/.test(clean)?'feature-flags-service':method==='post'&&clean==='/api/rag/sync'?'catalog-service'
        :clean.startsWith('/api/rag')?'rag-sync-service':clean.startsWith('/api/skills')?'skills-service':'catalog-service';
    return service===upstream?clean:null;
}

export function scanRoutes(ts,program,root){
    const result=[],device=deviceRules(ts,root);
    for(const source of program.getSourceFiles()){
        const filename=source.fileName;if(!filename.endsWith('.controller.ts')||!filename.startsWith(root+path.sep))continue;
        const service=path.relative(root,filename).split(path.sep)[1];if(!SERVICES.includes(service))continue;
        const bindings=nestBindings(ts,source);
        for(const declaration of source.statements){
            if(!ts.isClassDeclaration(declaration))continue;
            const controller=decorators(ts,declaration,bindings).find(item=>item.name==='Controller');if(!controller)continue;
            if(service==='api-gateway'&&declaration.name?.text==='ProxyController')continue;
            for(const method of declaration.members){
                if(!ts.isMethodDeclaration(method))continue;
                const meta=decorators(ts,method,bindings),route=meta.find(item=>HTTP.has(item.name));if(!route)continue;
                const verb=HTTP.get(route.name),verbs=verb==='all'?['get','post','delete']: [verb];
                for(const prefix of values(ts,controller.args[0],source))for(const suffix of values(ts,route.args[0],source))for(const http of verbs){
                    const visible=publicPath(service,http,prefix+'/'+suffix,device);if(!visible)continue;
                    for(const pathname of normalizePaths(visible))result.push({source,service,controller:declaration,method,meta,bindings,http,path:pathname,wildcards:[...visible.matchAll(/\*([A-Za-z_]\w*)/g)].map(match=>match[1]),all:verb==='all'});
                }
            }
        }
    }
    return result;
}
