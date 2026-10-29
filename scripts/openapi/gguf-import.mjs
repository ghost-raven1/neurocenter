import {DEFAULT_GGUF_IMPORT_POLICY} from '../../services/shared/gguf-import-policy.cjs';

const sha={type:'string',pattern:'^[a-f0-9]{64}$'};
const uuid={type:'string',format:'uuid',pattern:'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$'};
const integer={type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER};
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const policy=object(Object.fromEntries(Object.entries(DEFAULT_GGUF_IMPORT_POLICY).map(([key,value])=>[key,{...integer,default:value}])));
const metadata=object({format:{const:'gguf',type:'string'},version:{type:'integer',enum:[2,3]},architecture:{type:'string',pattern:'^[a-z0-9]+$'},tensorCount:integer,metadataCount:{type:'integer',minimum:0}});
const fileImport=object({format:{const:'gguf',type:'string'},uploadId:uuid,sha256:sha,bytes:integer,fileName:{type:'string'},architecture:{type:'string'},version:{type:'integer',enum:[2,3]}});
const receipt=object({id:uuid,requestKey:uuid,fileName:{type:'string'},bytes:integer,expectedSha256:sha,sha256:nullable(sha),state:{type:'string',enum:['WAITING','UPLOADING','READY','CANCELLED','ACCEPTED']},metadata:nullable(metadata),modelId:nullable({type:'string'}),expiresAt:{type:'string',format:'date-time'},limits:policy},['id','requestKey','fileName','bytes','sha256','state','metadata','modelId','expiresAt','limits']);
const model=object({id:{type:'string',pattern:'^model-gguf-'},name:{type:'string'},description:{type:'string'},capability:{type:'string',enum:['chat','embedding']},runtime:{const:'ollama',type:'string'},model:{type:'string'},manifestSha256:nullable(sha),dimension:nullable(integer),source:{const:'custom',type:'string'},revision:integer,createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'},archivedAt:nullable({type:'string',format:'date-time'}),modelPin:sha,fileImport},['id','name','description','capability','runtime','model','manifestSha256','dimension','source','revision','createdAt','updatedAt','fileImport']);
const json=(description,schema)=>({description,content:{'application/json':{schema}}});
const failure=description=>json(description,{$ref:'#/components/schemas/ApiError'});
const body=schema=>({required:true,content:{'application/json':{schema}}});
const base='/api/models/gguf-imports';

/** Overrides only the bounded GGUF control/data-plane contracts; generic route discovery remains authoritative. */
export function ggufImportOperation(method,path){
    const http=String(method).toLowerCase();
    const supported=http==='post'&&[base,base+'/{id}/accept'].includes(path)
        ||http==='put'&&path===base+'/{id}/content'
        ||http==='delete'&&path===base+'/{id}'
        ||http==='get'&&[base+'/limits',base+'/{id}',base+'/requests/{key}'].includes(path);
    if(!supported)return undefined;
    const parameters=[...path.matchAll(/\{(id|key)\}/g)].map(match=>({name:match[1],in:'path',required:true,schema:uuid}));
    const result={summary:'GGUF import',description:'Browser Main-admin only. Current enabled account and role are checked independently from gguf_import. Every import retains its effective configurable limit snapshot. Files are explicit local selections; no URL, registry download, remote-provider secret or executable template is accepted.',security:[{sessionCookie:[]}],parameters,
        responses:{400:failure('Invalid identifiers, fields, file envelope or declared byte count.'),401:failure('Browser authentication is missing or expired.'),403:failure('Current Main-admin authority was revoked, account disabled, or a new mutation is blocked by feature policy.'),404:failure('No import owned by the current actor exists for this identifier.'),409:failure('Request/accept fingerprint conflict, changed authority epoch, expired or cancelled draft, already accepted cancellation, quota exhaustion, or an active stream lease.'),503:failure('Catalog storage, feature policy or current admission settings are unavailable. Existing receipt reads and cancellation do not require a new policy.'),default:failure('Other server failure. Recover an uncertain response through the same request key or import identifier.')}};
    if(http==='post'&&path===base){
        result.summary='Create or recover a GGUF file import';
        result.description+=' requestKey is a UUID v4 permanently bound to the actor, original fileName, bytes and optional expectedSha256. Exact replay returns the original receipt before new-admission flag/policy checks; a changed fingerprint conflicts. Read limits first. Size and storage quota are checked against the current policy for new requests; accepted requests retain their snapshot.';
        result.requestBody=body(object({requestKey:uuid,fileName:{type:'string','x-neurocenter-utf8-byte-limit':240,pattern:'\\.[gG][gG][uU][fF]$',description:'Single file name, without path separators or control characters; at most 240 UTF-8 bytes. The byte bound is not a JSON Schema character-count approximation. Archives, split files, adapters and projectors are not supported.'},bytes:integer,expectedSha256:sha},['requestKey','fileName','bytes']));
        result.responses[201]=json('Durable import receipt. WAITING is an allocated request; READY proves checked file storage, independently from runtime readiness.',receipt);
    }else if(http==='put'){
        result.summary='Stream the exact GGUF content';
        result.description+=' Raw application/octet-stream with backpressure, server SHA-256, declared size checking and bounded GGUF v2/v3 little-endian inspection. No JSON/base64 or whole-file memory allocation. Content-Length is optional but must equal receipt.bytes if present. A READY/ACCEPTED replay returns the retained receipt. New streaming/READY commit requires enabled admission features and fresh authority. Interruption never returns a false READY; retry the same import or read its receipt.';
        parameters.push({name:'content-length',in:'header',required:false,schema:integer,description:'Must equal the bytes retained by this import receipt.'});
        result.requestBody={required:true,content:{'application/octet-stream':{schema:{type:'string',format:'binary'}}}};
        result.responses[200]=json('Checked file receipt with server-calculated SHA-256 and bounded GGUF metadata.',receipt);
        result.responses[413]=failure('The raw stream or declared length exceeds the exact bytes retained by this receipt.');
        result.responses[415]=failure('Use application/octet-stream. JSON, base64 and multipart are refused.');
        result.responses[502]=failure('Catalog transport or its retained-limit receipt was not confirmed. Check the same import before retrying.');
        result.responses[504]=failure('The retained upload timeout expired. Read the durable receipt before retrying.');
        result.responses[507]=failure('Insufficient physical free space including the configured reserve; no accepted source is deleted.');
    }else if(http==='post'){
        result.summary='Accept a checked GGUF into the existing model catalog';
        result.description+=' READY is required. The acceptance fingerprint is durable and creates one stable model ID; exact replay returns that model before new-write feature checks, including when gguf_import is OFF. Changed acceptance parameters conflict. The model has source custom, runtime ollama and honest fileImport identity. Its manifestSha256 remains null until explicit local Ollama activation and a real probe; the GGUF SHA is never substituted for the manifest SHA. Runtime start/check/stop uses the existing hosting endpoint and creates no model bundle export.';
        result.requestBody=body(object({name:{type:'string',minLength:1,maxLength:128},description:{type:'string',maxLength:4000},capability:{type:'string',enum:['chat','embedding']},model:{type:'string',maxLength:200,description:'Optional public model name with explicit tag. Omitted value is imported-<upload UUID>:v1. It does not select an external registry or runtime alias.'}},['name','capability']));
        result.responses[201]=json('The same stable IModel on an exact accepted replay. A later runtime check can add a genuine manifest SHA and embedding dimension to the current card.',model);
        result.responses[507]=failure('The configured physical storage reserve is no longer available. The checked file and request identity remain recoverable.');
    }else if(http==='delete'){
        result.summary='Cancel a GGUF import before acceptance';
        result.description+=' Cancellation remains available with gguf_import OFF and does not require current admission settings. It records CANCELLED before stopping a stream and safely defers file removal while a live stream lease exists. ACCEPTED sources are retained and return 409. Rights are checked again under the cancellation transaction.';
        result.responses[200]=json('Durable cancellation receipt. Deferred file cleanup never reopens a cancelled import.',receipt);
    }else if(path.endsWith('/limits')){
        result.summary='Read current configurable GGUF admission limits';
        result.description+=' Current policy for a new import. Existing import receipts retain their own limits. Values are bytes or milliseconds where named; metadataPairs, tensorCount, arrayElements, activeUploads and maximumPendingImports are counts. Administration uses the shared runtime-limits API.';
        result.responses[200]=json('Effective validated policy for new imports.',policy);
    }else{
        result.summary=path.includes('/requests/')?'Recover an own GGUF import by request key':'Read an own GGUF import receipt';
        result.description+=' Read-only recovery is available with gguf_import OFF and without a current policy lookup. Another actor cannot adopt the identifier. Filesystem paths and provider credentials are never returned.';
        result.responses[200]=json('Durable own receipt, including the original effective limit snapshot.',receipt);
    }
    return result;
}
