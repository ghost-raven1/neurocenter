import fs from 'node:fs';
import path from 'node:path';
import {controllerFiles,scanRoutes} from './routes.mjs';
import {createProgram,loadTypeScript} from './typescript.mjs';
import {createSchemaMapper} from './type-schema.mjs';
import {operation} from './operation.mjs';

/** Rebuilds the public contract from source declarations without executing application code. */
export function generateOpenApi(root){
    root=path.resolve(root);
    const ts=loadTypeScript(root),files=controllerFiles(root);
    if(!files.length)throw new Error('No NestJS controller sources found for OpenAPI generation.');
    const program=createProgram(ts,root,files);
    const checker=program.getTypeChecker(),mapper=createSchemaMapper(ts,checker),paths={};
    const ids=new Set();
    for(const route of scanRoutes(ts,program,root)){
        paths[route.path]??={};
        if(paths[route.path][route.http])throw new Error(`Duplicate public OpenAPI operation: ${route.http.toUpperCase()} ${route.path}`);
        const item=operation(ts,checker,mapper,route);
        if(ids.has(item.operationId))throw new Error('Duplicate OpenAPI operationId: '+item.operationId);ids.add(item.operationId);
        paths[route.path][route.http]=item;
    }
    const sortedPaths=Object.fromEntries(Object.keys(paths).sort().map(name=>[name,paths[name]]));
    let version='0.1.0';try{version=JSON.parse(fs.readFileSync(path.join(root,'services/api-gateway/package.json'),'utf8')).version||version;}catch{}
    return {openapi:'3.0.3',info:{title:'Neurocenter API',version,description:'Public API through the Neurocenter site. Browser requests use the current authenticated session and x-neurocenter-request: 1. Device Bearer tokens work only on their explicitly documented routes. Schemas are generated from controller TypeScript declarations; x-neurocenter-untyped marks structures not declared by the controller. Runtime validation may impose additional constraints.'},
        servers:[{url:'/',description:'Current Neurocenter site'}],paths:sortedPaths,
        components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'bridge_session',description:'Sign in to Neurocenter in this browser. HttpOnly session cookies are sent automatically; do not paste the cookie here.'},
            deviceBearer:{type:'http',scheme:'bearer',description:'Existing personal device token. It does not grant browser administration rights.'}},
        schemas:{...mapper.components.schemas,ApiError:{type:'object',properties:{message:{anyOf:[{type:'string'},{type:'array',items:{type:'string'}}]},error:{type:'string'},statusCode:{type:'integer'},code:{type:'string'}}}}},
        tags:[...new Set(Object.values(sortedPaths).flatMap(item=>Object.values(item).flatMap(value=>value.tags)))].sort().map(name=>({name}))};
}
