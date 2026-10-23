import path from 'node:path';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const slash=value=>value.split(path.sep).join('/');
/** Reviewed mock-only paths. Never refresh these pins automatically after a test/helper edit. */
export const auditedUnits=Object.freeze({
 "services/catalog-service/test/actor-canonical-publication.test.ts": {
  "sha256": "ece15ed945a17bc21495394066063f5569c8cf2379404298c8599c6fb71bf1ab",
  "helpers": {}
 },
 "services/catalog-service/test/agent-readiness-failure-boundaries.test.ts": {
  "sha256": "02e7d246a55ca41d611ed587d4950d5cd852193c1093dc15be037ed7d60e38ff",
  "helpers": {}
 },
 "services/catalog-service/test/asset-import-audit.test.ts": {
  "sha256": "fdd5fb2b028e39994118e96954debed2cf01d0f832d223505f31fb15090ec37a",
  "helpers": {}
 },
 "services/catalog-service/test/audit-history.test.ts": {
  "sha256": "980ab95df0b69f1ab6cf3594d71b22ebe272d61709dabd3afc1afd79a4e762c6",
  "helpers": {}
 },
 "services/catalog-service/test/catalog-migrations.test.ts": {
  "sha256": "eecc9d98676a4d8c0b62af862ae40cd504bdc9c341ea7c210099e554750fb829",
  "helpers": {}
 },
 "services/catalog-service/test/codex-connector-build.test.ts": {
  "sha256": "7574492d1a0a3ed6b02140622eec9743707ec7d74a2e1b6603b3e2970348955f",
  "helpers": {}
 },
 "services/catalog-service/test/device-completion-scope.test.ts": {
  "sha256": "4d5186877cff85ca33f93a18166aefb2bae4f9b54e36c7afeec9c94e14d489ed",
  "helpers": {}
 },
 "services/catalog-service/test/device-completion.test.ts": {
  "sha256": "bd19d7a3bd78afec9c71cd2e093c474a57171732aa5c0857337800a7c2a0ff58",
  "helpers": {}
 },
 "services/catalog-service/test/device-job-requests.test.ts": {
  "sha256": "ad44d99bb11d47913badc1d1cc03418cc293d2c9235ee48b792f7046b6b36174",
  "helpers": {}
 },
 "services/catalog-service/test/device-learning.test.ts": {
  "sha256": "150f7b51c5648197f88708d305248ea508f90740acae1f9c9a361c47551f015c",
  "helpers": {}
 },
 "services/catalog-service/test/feature-execution-boundaries.test.ts": {
  "sha256": "389b05101e3b40d5d3061f2b247d1c6a702c25899239541459faa9f4c610ee6d",
  "helpers": {}
 },
 "services/catalog-service/test/installation-inspection.test.ts": {
  "sha256": "9978e5f3eeeb7c5d34fac42f79956d1df739d933887b68163b70c30424937b11",
  "helpers": {}
 },
 "services/catalog-service/test/installation-set.test.ts": {
  "sha256": "5848ed517e39cb205493aa4ce52d7f2e711a1290087e0cb8b512f872ed05aa98",
  "helpers": {}
 },
 "services/catalog-service/test/mcp-configuration.test.ts": {
  "sha256": "6814dfefc7d9f898609d3e43e1a2e5c04dcf342cf35dad54e74f2f0045edba27",
  "helpers": {}
 },
 "services/catalog-service/test/model-catalog-repository.test.ts": {
  "sha256": "9d4acd76507a278237a5a0a3cc67d28a3daca89d600014ed3f7d1e557c918c5f",
  "helpers": {}
 },
 "services/catalog-service/test/model-hosting-control.test.ts": {
  "sha256": "e2bf06c9522de402afdadd158341c47fd0c71754ce8a987482668ad08381de6e",
  "helpers": {}
 },
 "services/catalog-service/test/model-verification.test.ts": {
  "sha256": "434fd9fd666bc8c756073edc1e6fdf1cf0acffbab030de16d9ac69e1c5619eef",
  "helpers": {}
 },
 "services/catalog-service/test/opencode-providers.test.ts": {
  "sha256": "ba049e43ddc12acf0e899d6030755349f9e71ec47c07770a72bfc77dc487ecec",
  "helpers": {}
 },
 "services/catalog-service/test/operation-bridge-capabilities.test.ts": {
  "sha256": "dbc7019fb02978a369600f384233ff82fec730991489723222f494f7ac9ed1b7",
  "helpers": {}
 },
 "services/catalog-service/test/package-build-admission.test.ts": {
  "sha256": "34d385934ce13099f36b0950700c9a4abf6c8ae33834045280d72006cbc3265c",
  "helpers": {}
 },
 "services/catalog-service/test/package-build-cancellation-control.test.ts": {
  "sha256": "3b34484fe2c21d8d920550568e3141bedd907eb418839bb3e1631cb128b32305",
  "helpers": {}
 },
 "services/catalog-service/test/package-build-publication-deadline.test.ts": {
  "sha256": "e6e02b814e76851030991ec9db6fe042d2cad65ff24b600e6cce48f76d6f5e89",
  "helpers": {}
 },
 "services/catalog-service/test/package-build-repository-deadline.test.ts": {
  "sha256": "aecf033f0913b31f9030e5c30d832477bbc334ab70e140bd8b7117aff798652f",
  "helpers": {}
 },
 "services/catalog-service/test/package-runtime-history.test.ts": {
  "sha256": "2726b35a7e22ecb8afab35c55be10503c1f9dc4bce6a7d2ebf22f7d1c331dc0b",
  "helpers": {
   "scripts/test/runtime-artifact-fixture.cjs": "d8a78b7bb261fbe23c91f4a9a42dd1b686c2d778084f28c6237abf2ad95a70ca"
  }
 },
 "services/catalog-service/test/project-embedding.test.ts": {
  "sha256": "1cca3e5c9caea28954f596e58319ad24c8bbf32e32a2be10927f86111cae4d52",
  "helpers": {}
 },
 "services/catalog-service/test/project-member-audit.test.ts": {
  "sha256": "85a27d368884db7b2dd8361deb7dc227e154c255d210f0d97b3cf7c6ef086670",
  "helpers": {}
 },
 "services/catalog-service/test/publication-audit.test.ts": {
  "sha256": "06d4aa15d08fab1d361c9c564a11947545cac4491bec464a37c6a62d9ee5190f",
  "helpers": {}
 },
 "services/catalog-service/test/publication-deadline.test.ts": {
  "sha256": "742c28bd66ddf3816946dd66bd8f295224c92a5a9613c8a3db1b04359907af1c",
  "helpers": {}
 },
 "services/catalog-service/test/publication-delete-audit.test.ts": {
  "sha256": "95ed80e91bef58cd9c174d4295df51ab4602163b09d6af5ef7651dee63e2c8da",
  "helpers": {}
 },
 "services/catalog-service/test/publication-delivery-boundary.test.ts": {
  "sha256": "7fa3adbb177204bd219d2b1c6bd6ff6476e2f52a42f7d4beaa512855a5d7b95b",
  "helpers": {}
 },
 "services/catalog-service/test/publication-dependencies.test.ts": {
  "sha256": "be74c7a38362ae875ac81fb8b35c71f5492c58e962bf824a1d267f793b72f06f",
  "helpers": {}
 },
 "services/catalog-service/test/publication-dependency-graph.test.ts": {
  "sha256": "84a3522bdfabea24586cd6881633414b65e9c0e4f271614b06351b16399c5a85",
  "helpers": {}
 },
 "services/catalog-service/test/publication-lease.test.ts": {
  "sha256": "bf935502e1364c81f02a945640d27a97d154882c29d4392bd9b318c7482f341b",
  "helpers": {}
 },
 "services/catalog-service/test/publication-lock-order.test.ts": {
  "sha256": "277fa6b6f246603ba3efc363827276e19c2dd313a7db2aa5f9f17cfc8e850ba6",
  "helpers": {}
 },
 "services/catalog-service/test/publication-target-cas.test.ts": {
  "sha256": "4e0e750743b604b6daa2b82bcbcd94d932b868db8ea3df7dc68a2378d4c961e9",
  "helpers": {}
 },
 "services/catalog-service/test/publication-transaction-configuration.test.ts": {
  "sha256": "2fc3319083baedd766c0bfba4c53b2ca7b35cc36bc5123b44f79712ca1f0558d",
  "helpers": {}
 },
 "services/catalog-service/test/publish-built-tool.test.ts": {
  "sha256": "0aecc39b5c99569209b1522d53f2c9f66d2e67922fe799f9014e5768a8c8ddbd",
  "helpers": {}
 },
 "services/catalog-service/test/queued-permission-reclamation.test.ts": {
  "sha256": "f1c33ce95a6baab35ff593e4bdaa48aad29f69ad6d804e5ce3f04c843c70188c",
  "helpers": {}
 },
 "services/catalog-service/test/runtime-job-artifact.test.ts": {
  "sha256": "fb6518c6c2f9cd0a232cca0f394c0593d5aa9ac2dd1730a96ad051a0cc935d67",
  "helpers": {}
 },
 "services/catalog-service/test/security-events-schema.test.ts": {
  "sha256": "50b2ae616ee6ebf077615ab37dfeab54a8e88ecfac3daa17430ffceaf3a891bc",
  "helpers": {}
 },
 "services/catalog-service/test/skill-audit-repository.test.ts": {
  "sha256": "23ae808dfd748daa8f50a6d32523cfdf8120861efed3b080f5fc13c09fe82af4",
  "helpers": {}
 },
 "services/catalog-service/test/skill-build-publication-intent.test.ts": {
  "sha256": "5a79762f1a721b2a30089943dc6cddb1b87a2b8b22590b3ab4b9ec95c1618536",
  "helpers": {}
 },
 "services/catalog-service/test/skill-dependency-preserve.test.ts": {
  "sha256": "b4f257760ef45396aeee8be7c3dd2cbc503b84b7a9195021c76bdae7f89d9463",
  "helpers": {}
 },
 "services/catalog-service/test/skill-dependency-registry.test.ts": {
  "sha256": "2c91832d5cda7f4c6fb3c4ac49daaf62a3073e427981878f3b6d4882c652a887",
  "helpers": {}
 },
 "services/catalog-service/test/skill-reference-access.test.ts": {
  "sha256": "acf9198909d6f81b6c22d95d3c6eb93c40bc181883f3b3945b55c167abf11e86",
  "helpers": {}
 },
 "services/catalog-service/test/workspace-failure.test.ts": {
  "sha256": "ada533c4c077b38e3a5feb7dc9380272dbafc501f0848309801daa6f100dfaeb",
  "helpers": {}
 },
 "services/catalog-service/test/workspace-queue.test.ts": {
  "sha256": "2afd8414af345512549ba0ce02487cb709a3eb2f18a74ca4edad97c82ea1670a",
  "helpers": {}
 },
 "services/feature-flags-service/test/flags-http.test.ts": {
  "sha256": "53e5af61a205b93b193c48eb654c27fe1ec55e4bd99b9c854150bd2e5eb85e1a",
  "helpers": {}
 },
 "services/feature-flags-service/test/flags-repository.test.ts": {
  "sha256": "a65208d7076a40a543dde1ea8faffc1a9a4c1ca9e3d641e8aad0edca85ca97ad",
  "helpers": {}
 }
});

const gap=String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*`;
const dependencies=new RegExp(String.raw`(?:\bfrom${gap}|\bimport${gap}(?:\(${gap})?|\brequire${gap}\(${gap})(['"])([^'"\r\n]+)\1`,'g');
/** Literal dependencies are inspected, never imported; ambiguous strings can only deny an exemption. */
export function runtimeDependencies(source){return [...source.matchAll(dependencies)].map(match=>match[2]);}
export function runtimePg(source){return runtimeDependencies(source).includes('pg');}
const verification=relative=>/(?:^|\/)(?:test|tests|fixtures|__tests__)(?:\/|$)/.test(relative);
const reAudit=relative=>Error('Unit-safe audit changed: '+relative+'. Re-audit this test and its runtime test helpers, then update scripts/coverage/unit-safe-profile.mjs after review; no automatic SHA refresh.');

async function ordinaryBytes(root,relative){
 const absolute=path.resolve(root,relative);
 if(!relative||path.isAbsolute(relative)||slash(path.relative(root,absolute))!==relative)throw reAudit(relative);
 try{if(!(await lstat(absolute)).isFile()||await realpath(absolute)!==absolute)throw reAudit(relative);return await readFile(absolute);}
 catch{throw reAudit(relative);}
}

/** Source and every permitted verification helper must retain the reviewed exact bytes. */
export async function validateAuditedUnit(root,relative,entry=auditedUnits[relative]){
 if(!entry)throw reAudit(relative);
 const bytes=await ordinaryBytes(root,relative);if(digest(bytes)!==entry.sha256)throw reAudit(relative);
 let runtime;try{runtime=stripTypeScriptTypes(bytes.toString('utf8'),{mode:'strip'});}catch{throw reAudit(relative);}
 const modules=runtimeDependencies(runtime);
 if(modules.some(name=>['pg','minio','@aws-sdk/client-s3'].includes(name)))throw reAudit(relative);
 if(modules.some(name=>path.isAbsolute(name)||name.startsWith('file:')))throw reAudit(relative);
 const local=modules.filter(name=>name.startsWith('.')).map(name=>slash(path.relative(root,path.resolve(root,path.dirname(relative),name))));
 if(local.some(name=>name.startsWith('../')||path.isAbsolute(name)))throw reAudit(relative);
 const helpers=[...new Set(local.filter(name=>verification(name)))].sort();
 if(JSON.stringify(helpers)!==JSON.stringify(Object.keys(entry.helpers).sort()))throw reAudit(relative);
 for(const helper of helpers){
  const content=await ordinaryBytes(root,helper);if(digest(content)!==entry.helpers[helper])throw reAudit(helper);
  // The sole reviewed helper is self-contained. No newly chained fixture is implicitly approved.
  if(runtimeDependencies(content.toString('utf8')).some(name=>['pg','minio','@aws-sdk/client-s3'].includes(name)||name.startsWith('.')||path.isAbsolute(name)||name.startsWith('file:')))throw reAudit(helper);
 }
 return runtime;
}

/** An exact reviewed exception removes only the legacy type-only pg import signal. */
export async function auditedUnitException(file,root=repository){
 const relative=slash(path.relative(root,file));if(!Object.hasOwn(auditedUnits,relative))return false;
 await validateAuditedUnit(root,relative);return true;
}

/** Preflight only the requested scope before output, any worker, or infrastructure admission. */
export async function validateUnitSafeProfile(root,{packages,chosen,testFiles=[]}){
 const folders=packages.filter(([id])=>!chosen.size||chosen.has(id)).map(([,folder])=>folder);
 for(const relative of Object.keys(auditedUnits)){
  const folder=folders.find(folder=>relative.startsWith(folder+'/test/'));
  if(folder&&(!testFiles.length||testFiles.includes(relative.slice(folder.length+1))))await validateAuditedUnit(root,relative);
 }
}
