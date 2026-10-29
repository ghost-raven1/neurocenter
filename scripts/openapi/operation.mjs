import {describeRemoteProviderAccess} from './remote-provider-access.mjs';
import {decorators,values} from './typescript.mjs';
import {describeComputerSetup} from './computer-setup.mjs';
import {describeProjectText} from './project-text.mjs';
import {describeRuntimeLimits} from './runtime-limits.mjs';
import {ggufImportOperation} from './gguf-import.mjs';

const stringSchema={type:'string'};
const freeForm=()=>({'x-neurocenter-untyped':true,description:'JSON body shape is not declared by this controller; server validation still applies.'});
const BINARY_UPLOAD=/^\/api\/(?:tool-builds\/uploads\/[^/]+\/content|projects\/[^/]+\/snapshot-uploads\/[^/]+\/blobs\/[^/]+|asset-sources\/archive|discussions\/attachments)$/;
const BINARY_DOWNLOAD=/\/(?:backups\/[^/]+\/download|versions\/[^/]+\/blobs\/[^/]+|tool-builds\/[^/]+\/supply|jobs\/[^/]+\/runtime\/[^/]+|discussions\/attachments\/[^/]+\/content)$/;
const SNAPSHOT_PUBLICATION=/^\/api\/projects\/[^/]+\/snapshot-uploads\/[^/]+\/(?:manifest|complete|status|blobs\/[^/]+)$/;

function security(route){
    const {path,http}=route;
    if(path.startsWith('/api/bridge/')||/^\/auth\/(?:login|callback|logout)$/.test(path)||/^\/api\/device-channel\/pair\/(?:start|poll)$/.test(path)||path.startsWith('/api/mcp-host/m/'))return [];
    if(path.startsWith('/api/device-channel/')||path==='/api/mcp-host/connect')return [{deviceBearer:[]}];
    // Learning records and human decisions are private to browser sessions; devices use the bound channel.
    if(/^\/api\/projects\/[^/]+\/(?:learning|team-chat)(?:\/|$)/.test(path))return [{sessionCookie:[]}];
    if(/^\/api\/projects\/[^/]+\/agents\/(?:readiness$|[^/]+\/readiness-trials(?:\/|$))/.test(path))return [{sessionCookie:[]}];
    const bearerRead=['get','head'].includes(http)&&/^\/api\/(projects|ai-plugins|skills|rag)(\/|$)/.test(path);
    const bearerSync=http==='post'&&['/api/skills/sync','/api/rag/sync'].includes(path);
    const bearerPublication=SNAPSHOT_PUBLICATION.test(path);
    return [{sessionCookie:[]},...(bearerRead||bearerSync||bearerPublication?[{deviceBearer:[]}]:[])];
}

function errorResponses(protectedRoute){
    const response=description=>({description,content:{'application/json':{schema:{$ref:'#/components/schemas/ApiError'}}}});
    return {'400':response('Request did not pass server validation.'),...(protectedRoute?{'401':response('Authentication is missing or expired.'),'403':response('The current role or project grant does not allow this action.')}:{})
        ,default:response('Other server error; exact status and validation details depend on the operation.')};
}

function manualResponse(ts,checker,mapper,method,bindings,status){
    const names=method.parameters.filter(item=>decorators(ts,item,bindings).some(meta=>meta.name==='Res')).map(item=>item.name.getText());
    const serializers=method.getSourceFile().statements.flatMap(item=>ts.isImportDeclaration(item)&&item.moduleSpecifier.text==='@neurocenter/asset-contract'&&item.importClause?.namedBindings&&ts.isNamedImports(item.importClause.namedBindings)
        ?item.importClause.namedBindings.elements.filter(name=>(name.propertyName?.text||name.name.text)==='serializeAsset').map(name=>name.name.text):[]);
    const found=[];
    const scan=node=>{
        if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['json','send'].includes(node.expression.name.text)&&node.arguments[0]){
            let receiver=node.expression.expression,code;
            while(ts.isCallExpression(receiver)&&ts.isPropertyAccessExpression(receiver.expression)){
                if(receiver.expression.name.text==='status'&&receiver.arguments[0]&&ts.isNumericLiteral(receiver.arguments[0]))code=receiver.arguments[0].text;
                receiver=receiver.expression.expression;
            }
            if(ts.isIdentifier(receiver)&&names.includes(receiver.text)&&(code||'200')===status){
                // Canonical asset serialization sends JSON text, whose HTTP representation is the asset object.
                let payload=node.arguments[0];
                if(ts.isCallExpression(payload)&&ts.isIdentifier(payload.expression)&&serializers.includes(payload.expression.text)&&payload.arguments[0])payload=payload.arguments[0];
                found.push(mapper.schema(checker.getTypeAtLocation(payload),payload));
            }
        }
        ts.forEachChild(node,scan);
    };
    if(method.body)scan(method.body);
    return found.length===1?found[0]:found.length?{anyOf:found}:undefined;
}

function thrownStatuses(ts,method,bindings){
    const known={BadRequestException:'400',UnauthorizedException:'401',ForbiddenException:'403',NotFoundException:'404',ConflictException:'409',GoneException:'410',UnprocessableEntityException:'422',ServiceUnavailableException:'503'},found=new Set();
    const scan=node=>{if(ts.isThrowStatement(node)&&node.expression&&ts.isNewExpression(node.expression)&&ts.isIdentifier(node.expression.expression)){
        const name=bindings.get(node.expression.expression.text);if(known[name])found.add(known[name]);
    }ts.forEachChild(node,scan);};
    if(method.body)scan(method.body);return [...found];
}

/** Controller annotations describe transport; untyped parts stay explicit rather than receiving fabricated fields. */
export function operation(ts,checker,mapper,route){
    const {source,method,bindings,http,path,meta}=route;
    const signature=checker.getSignatureFromDeclaration(method),symbol=checker.getSymbolAtLocation(method.name);
    const documentation=symbol?ts.displayPartsToString(symbol.getDocumentationComment(checker)):'';
    const summary=(documentation.split('\n').find(line=>line.trim())||`${http.toUpperCase()} ${path}`).slice(0,160);
    const parameters=[],pathNames=[...path.matchAll(/\{([^{}]+)\}/g)].map(match=>match[1]);
    let body;
    for(const parameter of method.parameters){
        const annotation=decorators(ts,parameter,bindings).find(item=>['Body','Query','Param','Headers'].includes(item.name));
        if(!annotation)continue;
        const type=checker.getTypeAtLocation(parameter),schema=mapper.schema(type,parameter)||{};
        const key=annotation.args[0]?values(ts,annotation.args[0],source)[0]:undefined;
        if(annotation.name==='Body'){
            if(key){body??={type:'object',properties:{}};body.properties[key]=schema;}
            else body=schema;
            continue;
        }
        const kind=annotation.name==='Param'?'path':annotation.name==='Query'?'query':'header';
        if(kind==='header'&&(!key||/^x-(?:neurocenter-internal|bridge-)/i.test(key)||key.toLowerCase()==='authorization'))continue;
        if(key){
            if(kind==='path'&&!pathNames.includes(key))continue;
            const optional=!!parameter.questionToken||!!parameter.initializer||type.isUnion()&&type.types.some(item=>item.flags&ts.TypeFlags.Undefined);
            parameters.push({name:key,in:kind,required:kind==='path'||!optional,schema,...(route.wildcards.includes(key)?{description:'Catch-all path; may contain slash-separated segments.','x-neurocenter-catch-all':true}:{})});
        }else if(schema.properties){
            for(const [name,item]of Object.entries(schema.properties))parameters.push({name,in:kind,required:kind==='path'||!!schema.required?.includes(name),schema:item});
        }else if(kind==='query')parameters.push({name:'query',in:'query',required:false,style:'form',explode:true,schema,description:'Query object. Its keys are sent as individual query parameters.'});
    }
    for(const name of pathNames)if(!parameters.some(item=>item.in==='path'&&item.name===name))parameters.push({name,in:'path',required:true,schema:stringSchema,...(route.wildcards.includes(name)?{description:'Catch-all path; may contain slash-separated segments.','x-neurocenter-catch-all':true}:{})});
    // Query unions describe the raw HTTP input; this RAG validator explicitly requires projectKey.
    if(path.startsWith('/api/rag/'))for(const parameter of parameters)if(parameter.in==='query'&&parameter.name==='projectKey')parameter.required=true;
    if(path.startsWith('/api/skills/_package/'))for(const parameter of parameters)if(parameter.in==='query'&&parameter.name==='version')parameter.required=true;
    if(/^\/api\/device-channel\/jobs\/[^/]+\/runtime\//.test(path))parameters.push({name:'x-neurocenter-job-lease',in:'header',required:true,schema:{type:'string',format:'uuid'},description:'Current runtime-job lease issued by the device channel.'});
    if(SNAPSHOT_PUBLICATION.test(path))for(const name of ['x-neurocenter-job-id','x-neurocenter-job-lease'])parameters.push({name,in:'header',required:false,schema:{type:'string',format:'uuid'},description:'Required when using deviceBearer authentication. Use the current snapshot job and lease; browser session requests do not require this header.'});
    if(path==='/api/discussions/attachments'&&http==='post')parameters.push(
        {name:'targetType',in:'query',required:true,schema:{type:'string',enum:['catalog','help']}},
        {name:'targetId',in:'query',required:true,schema:{type:'string'},description:'Help slug or catalog kind:stableId; skill IDs may contain slash characters.'},
        {name:'x-file-name',in:'header',required:true,schema:stringSchema,description:'Percent-encoded UTF-8 file name.'},
        {name:'x-request-key',in:'header',required:true,schema:{type:'string',format:'uuid'}},
        {name:'content-length',in:'header',required:true,schema:{type:'integer',minimum:1,maximum:10485760}}
    );
    const responseDecorator=meta.find(item=>item.name==='HttpCode'),code=responseDecorator?values(ts,responseDecorator.args[0],source)[0]:http==='post'?'201':'200';
    const authRedirect=route.service==='oauth2-bridge'&&http==='get'&&/^\/auth\/(?:login|callback|logout)$/.test(path);
    const explicitOAuthJson=route.service==='oauth2-bridge'&&http==='post';
    const headSupply=http==='head'&&/^\/api\/tool-builds\/[^/]+\/supply$/.test(path);
    const status=authRedirect?'302':explicitOAuthJson||route.all?'200':headSupply?'204':code;
    const responseType=signature?checker.getReturnTypeOfSignature(signature):undefined;
    const mapped=mapper.schema(responseType,method)||manualResponse(ts,checker,mapper,method,bindings,status);
    const binaryDownload=BINARY_DOWNLOAD.test(path)||/^\/api\/bridge\/(?:runtime|opencode)\//.test(path);
    const gzipDownload=/^\/api\/(?:tool-builds\/[^/]+\/supply|device-channel\/jobs\/[^/]+\/runtime\/[^/]+)$/.test(path);
    let success={description:authRedirect?'Redirects the browser; response location is in the Location header.':status==='204'?'No response body.':'Successful response.'};
    if(authRedirect)success.headers={Location:{description:'Redirect destination chosen by the authentication flow.',schema:stringSchema}};
    else if(http!=='head'&&status!=='204')success.content=binaryDownload?{[gzipDownload?'application/gzip':'application/octet-stream']:{schema:{type:'string',format:'binary'}}}:
        /^\/api\/bridge\/install/.test(path)?{'text/plain':{schema:stringSchema}}:{'application/json':{schema:mapped||{'x-neurocenter-untyped':true,description:'The controller writes the HTTP response directly.'}}};
    if(/^\/api\/bridge\/(?:runtime|opencode)\//.test(path))success.content={'application/gzip':{schema:{type:'string',format:'binary'}},'text/plain':{schema:stringSchema},...(path.includes('/runtime/')?{'application/json':{schema:{type:'object',additionalProperties:true,description:'Immutable runtime metadata when file ends in .json.'}}}:{})};
    if(!body&&['post','put','patch'].includes(http)&&!BINARY_UPLOAD.test(path)){
        // Only a real body annotation declares JSON input. @Req alone does not invent a body.
        const usesBody=method.body&&/\b\w+\.body\b/.test(method.body.getText(source));
        if(usesBody)body=freeForm();
    }
    if(BINARY_UPLOAD.test(path))body={type:'string',format:'binary'};
    if(route.all&&http==='post')body=freeForm();
    const result={tags:[path.startsWith('/auth/')?'Authentication':path.split('/')[2]||'API'],summary,
        ...(documentation?{description:documentation}:{}),operationId:`${http}_${path.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_|_$/g,'')}`,
        security:security(route),parameters,responses:{[status]:success,...errorResponses(security(route).length>0)},
        'x-neurocenter-service':route.service};
    if(body&&http!=='get'&&http!=='head')result.requestBody={required:true,content:{[BINARY_UPLOAD.test(path)?'application/octet-stream':'application/json']:{schema:body}}};
    if(route.all){
        result.description=(result.description?result.description+'\n\n':'')+'Streamable HTTP MCP channel. Authentication uses the signed ticket in the path.';
        if(['get','post'].includes(http))success.content={'application/json':{schema:freeForm()},'text/event-stream':{schema:{type:'string',description:'Server-sent MCP protocol messages.'}}};
        result.responses['405']={description:'This transport method is not supported.'};if(http==='post')result.responses['202']={description:'MCP notification accepted; no response body.'};
    }
    const unwrapped=responseType&&(checker.getPromisedTypeOfPromise(responseType)||responseType);
    if(unwrapped?.flags&ts.TypeFlags.Never){
        delete result.responses[status];
        for(const failure of thrownStatuses(ts,method,bindings))result.responses[failure]={description:'This endpoint rejects the operation. '+(documentation||'See the server error message.')};
        result.deprecated=true;result.description=(result.description?result.description+'\n\n':'')+'This retained endpoint has no successful response.';
    }
    const described=describeRemoteProviderAccess(describeRuntimeLimits(describeProjectText(describeComputerSetup(result,path,http),path,http),path,http),path,http);
    return Object.assign(described,ggufImportOperation(http,path)??{});
}
