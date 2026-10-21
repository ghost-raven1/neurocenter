import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/** Compiler-only loading never imports service modules or initializes their databases. */
export function loadTypeScript(root){
    const candidates=['services/api-gateway/package.json','package.json'];
    for(const relative of candidates){try{return createRequire(path.join(root,relative))('typescript');}catch{}}
    throw new Error('OpenAPI generation requires installed TypeScript in api-gateway or the workspace.');
}

/** All services use the build dependency versions installed beside Gateway, including in source-only Docker builds. */
export function createProgram(ts,root,files){
    const gatewayModules=path.join(root,'services/api-gateway/node_modules');
    const modules=fs.existsSync(gatewayModules)?gatewayModules:path.join(root,'node_modules');
    const realModules=fs.realpathSync(modules),anchor=path.join(path.dirname(modules),'src/__openapi__.ts');
    const options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,
        experimentalDecorators:true,emitDecoratorMetadata:true,strictNullChecks:true,esModuleInterop:true,allowJs:true,skipLibCheck:true,noEmit:true,
        typeRoots:[path.join(modules,'@types')]};
    const host=ts.createCompilerHost(options),cache=ts.createModuleResolutionCache(root,item=>item,options);
    host.resolveModuleNames=(names,filename)=>names.map(name=>{
        const relative=name.startsWith('.')||path.isAbsolute(name);
        const resolved=ts.resolveModuleName(name,relative?filename:anchor,options,host,cache).resolvedModule;
        if(!resolved||relative)return resolved;
        const real=fs.realpathSync(resolved.resolvedFileName);
        return real.startsWith(realModules+path.sep)?resolved:undefined;
    });
    return ts.createProgram(files,options,host);
}

export function decorators(ts,node,bindings){
    return (ts.getDecorators(node)||[]).flatMap(decorator=>{
        const expression=decorator.expression;
        if(!ts.isCallExpression(expression)||!ts.isIdentifier(expression.expression))return [];
        const name=bindings.get(expression.expression.text);
        return name?[{name,args:[...expression.arguments],node:decorator}]:[];
    });
}

export function nestBindings(ts,source){
    const bindings=new Map();
    for(const statement of source.statements){
        if(!ts.isImportDeclaration(statement)||statement.moduleSpecifier.text!=='@nestjs/common')continue;
        const names=statement.importClause?.namedBindings;
        if(names&&ts.isNamedImports(names))for(const item of names.elements)bindings.set(item.name.text,item.propertyName?.text||item.name.text);
    }
    return bindings;
}

/** Route expressions are deliberately static; dynamic paths fail the build instead of silently disappearing. */
export function values(ts,node,source,seen=new Set()){
    if(!node)return [''];
    if(ts.isStringLiteralLike(node)||ts.isNumericLiteral(node))return [String(node.text)];
    if(ts.isArrayLiteralExpression(node))return node.elements.flatMap(item=>values(ts,item,source,seen));
    if(ts.isIdentifier(node)&&!seen.has(node.text)){
        const next=new Set([...seen,node.text]);
        for(const statement of source.statements)if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations){
            if(ts.isIdentifier(declaration.name)&&declaration.name.text===node.text&&declaration.initializer)return values(ts,declaration.initializer,source,next);
        }
    }
    throw new Error(`Unsupported static route expression in ${source.fileName}: ${node.getText(source)}`);
}
