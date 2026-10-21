import {createRequire} from 'node:module';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const readers=new Set(['readFile','readFileSync','createReadStream','readdir','readdirSync','opendir','opendirSync',
    'exists','existsSync','access','accessSync','stat','statSync','lstat','lstatSync','realpath','realpathSync']);
const children=node=>Object.values(node).flatMap(value=>Array.isArray(value)?value.filter(item=>item?.type):value?.type?[value]:[]);
const property=node=>node.computed?node.property.type==='Literal'?String(node.property.value):undefined:node.property.name;
const fsModule=value=>['fs','node:fs','fs/promises','node:fs/promises'].includes(value)?'fs':['module','node:module'].includes(value)?'module':undefined;
const functionNode=node=>/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type);

/** Bundling relocates modules; reject known module-relative fs reads rather than publish missing resources. */
export async function assertPortableSourceResources(source,filename){
    const extension=filename.split('.').at(-1),loader=['ts','mts','cts','tsx'].includes(extension)?extension==='tsx'?'tsx':'ts':extension==='jsx'?'jsx':'js';
    const javascript=await require('esbuild').transform(source,{loader,target:'esnext',treeShaking:false,sourcefile:filename});
    const tree=require('acorn').parse(javascript.code,{ecmaVersion:'latest',sourceType:'module',allowHashBang:true,allowReturnOutsideFunction:true});
    const scopes=new WeakMap(),root={bindings:new Map(),parent:null,function:true};
    const member=(object,key)=>({type:'MemberExpression',object,property:{type:'Identifier',name:key},computed:false});
    function bind(pattern,value,scope,referenceScope=scope){
        if(!pattern)return;
        if(pattern.type==='Identifier')scope.bindings.set(pattern.name,{value,scope:referenceScope});
        else if(pattern.type==='ObjectPattern')for(const entry of pattern.properties){
            if(entry.type==='Property')bind(entry.value,value&&member(value,entry.computed?entry.key.value:entry.key.name??entry.key.value),scope,referenceScope);
            else bind(entry.argument,undefined,scope,referenceScope);
        }
        else if(pattern.type==='AssignmentPattern')bind(pattern.left,value,scope,referenceScope);
        else if(pattern.type==='RestElement')bind(pattern.argument,undefined,scope,referenceScope);
        else if(pattern.type==='ArrayPattern')for(const item of pattern.elements)bind(item,undefined,scope,referenceScope);
    }
    function index(node,scope){
        if(node.type==='FunctionDeclaration'&&node.id)bind(node.id,undefined,scope);
        if(functionNode(node)){
            scope={bindings:new Map(),parent:scope,function:true};
            if(node.id)bind(node.id,undefined,scope);
            for(const parameter of node.params)bind(parameter,undefined,scope);
        }else if(node.type==='BlockStatement'||node.type==='CatchClause'){
            scope={bindings:new Map(),parent:scope};
            if(node.param)bind(node.param,undefined,scope);
        }
        scopes.set(node,scope);
        if(node.type==='ImportDeclaration')for(const specifier of node.specifiers){
            const module=fsModule(node.source.value);
            scope.bindings.set(specifier.local.name,{symbol:module&&(specifier.type==='ImportSpecifier'?module+'.'+(specifier.imported.name??specifier.imported.value):module)});
        }
        if(node.type==='VariableDeclaration')for(const declaration of node.declarations){
            let destination=scope;
            if(node.kind==='var')while(!destination.function)destination=destination.parent;
            bind(declaration.id,declaration.init,destination,scope);
        }
        if(node.type==='ClassDeclaration'&&node.id)bind(node.id,undefined,scope);
        for(const child of children(node))index(child,scope);
    }
    index(tree,root);
    const binding=(name,scope)=>{for(let current=scope;current;current=current.parent)if(current.bindings.has(name))return current.bindings.get(name);};
    function symbol(node,scope,seen=new Set()){
        if(!node)return;
        if(node.type==='Identifier'){
            const value=binding(node.name,scope);
            if(!value)return node.name==='require'?'require':undefined;
            if(value.symbol)return value.symbol;
            if(!value.value||seen.has(value))return;
            return symbol(value.value,value.scope,new Set([...seen,value]));
        }
        if(node.type==='AwaitExpression'||node.type==='ChainExpression')return symbol(node.argument??node.expression,scope,seen);
        if(node.type==='ImportExpression')return fsModule(node.source.value);
        if(node.type==='MemberExpression'){
            const base=symbol(node.object,scope,seen),key=property(node);
            if(base&&key)return base+'.'+key;
        }
        if(node.type==='CallExpression'){
            const callee=symbol(node.callee,scope,seen);
            if(callee==='require')return fsModule(node.arguments[0]?.value);
            if(callee==='module.createRequire')return 'require';
        }
    }
    function anchored(node,scope,seen=new Set()){
        if(!node)return false;
        if(node.type==='Identifier'){
            const value=binding(node.name,scope);
            if(!value)return ['__dirname','__filename'].includes(node.name);
            if(!value.value||seen.has(value))return false;
            return anchored(value.value,value.scope,new Set([...seen,value]));
        }
        if(node.type==='MemberExpression'&&node.object.type==='MetaProperty'&&node.object.meta.name==='import'&&property(node)==='url')return true;
        if(node.type==='MemberExpression')return anchored(node.object,scope,seen)||node.computed&&anchored(node.property,scope,seen);
        if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='URL'&&typeof node.arguments[0]?.value==='string'
            &&/^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/)/.test(node.arguments[0].value))return false;
        if(functionNode(node))return false;
        return children(node).some(child=>anchored(child,scope,seen));
    }
    function inspect(node){
        if(node.type==='CallExpression'){
            const scope=scopes.get(node),callee=symbol(node.callee,scope),api=callee?.replace(/^fs\.(?:promises\.)?/,'');
            const open=api==='open'||api==='openSync';
            const reads=open?node.arguments[1]===undefined||typeof node.arguments[1].value==='string'&&node.arguments[1].value.startsWith('r'):readers.has(api);
            if(callee?.startsWith('fs.')&&reads&&anchored(node.arguments[0],scope))throw Object.assign(new Error(
                `Исходник ${filename} читает ресурс относительно своего расположения (${api}). При сборке JS/TS такие файлы не переносятся. Выберите готовый JavaScript npm-пакет; готовый MCP также можно добавить runtime-архивом с ресурсами.`),{code:'SOURCE_RESOURCE_UNSUPPORTED'});
        }
        for(const child of children(node))inspect(child);
    }
    inspect(tree);
}
