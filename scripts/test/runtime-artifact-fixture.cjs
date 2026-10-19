'use strict';
const {gzipSync}=require('node:zlib');
const {createHash}=require('node:crypto');
/** Маленький настоящий USTAR для вредоносных путей и оборванных загрузок. */
function artifactFixture(files=[{path:'runtime/server.mjs',content:'export default {};',mode:0o644}],target='darwin-arm64'){
 const blocks=[];for(const file of files){const bytes=Buffer.from(file.content||'');const header=Buffer.alloc(512);header.write(file.path,0,100,'utf8');header.write((file.mode??0o644).toString(8).padStart(7,'0')+'\0',100,'ascii');header.write('0000000\0',108,'ascii');header.write('0000000\0',116,'ascii');header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124,'ascii');header.write('00000000000\0',136,'ascii');header.fill(32,148,156);header[156]=(file.type??'0').charCodeAt(0);if(file.link)header.write(file.link,157,100,'utf8');header.write('ustar\0',257,'ascii');header.write('00',263,'ascii');let sum=0;for(const byte of header)sum+=byte;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));}blocks.push(Buffer.alloc(1024));const archive=gzipSync(Buffer.concat(blocks));return {archive,descriptor:{target,sha256:createHash('sha256').update(archive).digest('hex'),compressedBytes:archive.length,unpackedBytes:files.reduce((sum,file)=>sum+Buffer.byteLength(file.content||''),0),filesCount:files.filter(file=>(file.type??'0')==='0').length,entrypoint:files.find(file=>(file.type??'0')==='0')?.path||'runtime/server.mjs'}};
}
module.exports={artifactFixture};
