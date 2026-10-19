import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function archiveFile(name,bytes) {
    const header=Buffer.alloc(512);header.write(name,0,100,'utf8');
    const octal=(value,start,length)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',start,length,'ascii');
    octal(0o644,100,8);octal(0,108,8);octal(0,116,8);octal(bytes.length,124,12);octal(0,136,12);header.fill(32,148,156);
    header[156]=48;header.write('ustar\0',257,6,'ascii');header.write('00',263,2,'ascii');
    header.write(header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
    return gzipSync(Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512),Buffer.alloc(1024)]));
}
const connection = `const fs=require('node:fs/promises');const {Pool}=require('pg');
const {RuntimeArtifacts}=require('/app/dist/runtime-artifacts/runtime-artifacts.js');
const pool=new Pool({connectionString:process.env.CATALOG_PG_URL_FILE?(await fs.readFile(process.env.CATALOG_PG_URL_FILE,'utf8')).trim():process.env.CATALOG_PG_URL});
const service=new RuntimeArtifacts({pool});`;

/** Импорт выполняется продуктовым операторским сервисом внутри собственного production-контейнера. */
export async function seedProductionRuntimeArtifact(client,run) {
    assert.match(run,/^[a-f0-9]{8}$/);
    const target=await client.run(['exec','-T','catalog-service','node','-e',"console.log(process.platform+'-'+process.arch+'-'+(process.report.getReport().header.glibcVersionRuntime?'glibc':'musl'))"]);
    assert.match(target,/^linux-(arm64|x64)-(glibc|musl)$/);
    const source=Buffer.from(`// Собственный комплект полного DR ${run}. Код при импорте и восстановлении не запускается.\nexport const fixture = ${JSON.stringify(run)};\n`);
    const bytes=archiveFile('runtime/index.mjs',source);
    const descriptor={target,sha256:hash(bytes),compressedBytes:bytes.length,unpackedBytes:source.length,filesCount:1,entrypoint:'runtime/index.mjs'};
    const script=`(async()=>{${connection}
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);const temporary='/tmp/neurocenter-runtime-dr-'+input.fixtureId+'.tar.gz';
try{await fs.writeFile(temporary,Buffer.from(input.archive,'base64'),{flag:'wx',mode:0o600});
const artifact=await service.importArchive(temporary,input.descriptor);console.log(JSON.stringify({imported:true,artifact}));}
finally{await fs.rm(temporary,{force:true});await pool.end();}})().catch(()=>{console.error('Не удалось импортировать собственный DR-артефакт');process.exitCode=1;});`;
    const result=JSON.parse(await client.run(['exec','-T','catalog-service','node','-e',script],{input:JSON.stringify({fixtureId:run,archive:bytes.toString('base64'),descriptor})}));
    assert.equal(result.imported,true);assert.deepEqual(result.artifact,descriptor);
    await verifyProductionRuntimeArtifact(client,descriptor);return descriptor;
}

/** Чтение проходит через продуктовый open: проверяются строка PostgreSQL и настоящие байты отдельного тома. */
export async function verifyProductionRuntimeArtifact(client,expected) {
    const script=`(async()=>{${connection}
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);try{
const opened=await service.open(input.sha256);const hash=require('node:crypto').createHash('sha256');let bytes=0;
for await(const chunk of opened.stream){bytes+=chunk.length;hash.update(chunk);}
const row=(await pool.query('SELECT sha256,compressed_bytes,unpacked_bytes,files_count FROM bridge_runtime_artifacts WHERE sha256=$1',[input.sha256])).rows[0];
console.log(JSON.stringify({sha256:hash.digest('hex'),bytes,row}));}finally{await pool.end();}})().catch(()=>{console.error('Готовый DR-комплект не прошёл проверку');process.exitCode=1;});`;
    const value=JSON.parse(await client.run(['exec','-T','catalog-service','node','-e',script],{input:JSON.stringify(expected)}));
    assert.equal(value.sha256,expected.sha256);assert.equal(value.bytes,expected.compressedBytes);
    assert.deepEqual(value.row,{sha256:expected.sha256,compressed_bytes:String(expected.compressedBytes),unpacked_bytes:String(expected.unpackedBytes),files_count:expected.filesCount});
    return value;
}
