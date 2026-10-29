const u32=(value:number)=>{const bytes=Buffer.alloc(4);bytes.writeUInt32LE(value);return bytes;};
const u64=(value:number)=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(BigInt(value));return bytes;};
const string=(value:string)=>Buffer.concat([u64(Buffer.byteLength(value)),Buffer.from(value)]);
/** Minimal real GGUF envelope; no weights are downloaded and no fixture executes. */
export function gguf(options:{version?:number;architecture?:string;metadata?:Array<[string,string|number]>;tensors?:Array<{name:string;dimensions?:number[];type?:number;offset?:number}>;dataBytes?:number}={}){
 const metadata:Array<[string,string|number]>=[['general.architecture',options.architecture??'llama'],...(options.metadata??[])],tensors=options.tensors??[{name:'token_embd.weight'}];
 const header=Buffer.concat([Buffer.from('GGUF'),u32(options.version??3),u64(tensors.length),u64(metadata.length),...metadata.flatMap(([key,value])=>[string(key),u32(typeof value==='string'?8:4),typeof value==='string'?string(value):u32(value)]),...tensors.flatMap(tensor=>{const dims=tensor.dimensions??[4];return [string(tensor.name),u32(dims.length),...dims.map(u64),u32(tensor.type??0),u64(tensor.offset??0)];})]);
 return Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(options.dataBytes??16)]);
}
