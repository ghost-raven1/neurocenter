import {Header} from 'tar';
import * as zlib from 'node:zlib';
export interface FixtureEntry{path:string;content?:Buffer|string;type?:Header['type'];link?:string;mode?:number;encrypted?:boolean;crc?:number;rawName?:Buffer;unpacked?:number;method?:0|8;descriptor?:boolean;zip64?:boolean;compressedTail?:Buffer}
const crc32=(zlib as typeof zlib&{crc32:(bytes:Buffer)=>number}).crc32;
export function tar(files:FixtureEntry[]):Buffer{
    const chunks:Buffer[]=[];
    for(const file of files){const bytes=Buffer.from(file.content??''),header=new Header({path:file.path,type:file.type??'File',size:file.unpacked??bytes.length,mode:file.mode??0o644,linkpath:file.link});header.encode();chunks.push(header.block!,bytes,Buffer.alloc((512-bytes.length%512)%512));}
    return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}
export function zip(files:FixtureEntry[],wideDirectory=false):Buffer{
    const chunks:Buffer[]=[],central:Buffer[]=[];let offset=0;
    for(const file of files){
        const name=file.rawName??Buffer.from(file.path),bytes=Buffer.from(file.content??''),method=file.method??8,compressed=Buffer.concat([method===8?zlib.deflateRawSync(bytes):bytes,file.compressedTail??Buffer.alloc(0)]),checksum=file.crc??crc32(bytes),size=file.unpacked??bytes.length;
        const flag=0x800|(file.encrypted?1:0)|(file.descriptor?8:0),local=Buffer.alloc(30),record=Buffer.alloc(46),extra=file.zip64?Buffer.alloc(20):Buffer.alloc(0);
        if(file.zip64){extra.writeUInt16LE(1);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(BigInt(size),4);extra.writeBigUInt64LE(BigInt(compressed.length),12);}
        local.writeUInt32LE(0x04034b50);local.writeUInt16LE(file.zip64?45:20,4);local.writeUInt16LE(flag,6);local.writeUInt16LE(method,8);
        local.writeUInt32LE(file.descriptor?0:checksum,14);local.writeUInt32LE(file.zip64?0xffffffff:file.descriptor?0:compressed.length,18);local.writeUInt32LE(file.zip64?0xffffffff:file.descriptor?0:size,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(extra.length,28);
        record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x314,4);record.writeUInt16LE(file.zip64?45:20,6);record.writeUInt16LE(flag,8);record.writeUInt16LE(method,10);record.writeUInt32LE(checksum,16);record.writeUInt32LE(file.zip64?0xffffffff:compressed.length,20);record.writeUInt32LE(file.zip64?0xffffffff:size,24);record.writeUInt16LE(name.length,28);record.writeUInt16LE(extra.length,30);record.writeUInt32LE(((file.mode??(file.path.endsWith('/')?0o040755:0o100644))<<16)>>>0,38);record.writeUInt32LE(offset,42);
        const descriptor=file.descriptor?Buffer.alloc(file.zip64?24:16):Buffer.alloc(0);
        if(file.descriptor){descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(checksum,4);if(file.zip64){descriptor.writeBigUInt64LE(BigInt(compressed.length),8);descriptor.writeBigUInt64LE(BigInt(size),16);}else{descriptor.writeUInt32LE(compressed.length,8);descriptor.writeUInt32LE(size,12);}}
        chunks.push(local,name,extra,compressed,descriptor);central.push(record,name,extra);offset+=local.length+name.length+extra.length+compressed.length+descriptor.length;
    }
    const directory=Buffer.concat(central),end=Buffer.alloc(22),zip64=wideDirectory?Buffer.alloc(76):Buffer.alloc(0);
    if(wideDirectory){zip64.writeUInt32LE(0x06064b50);zip64.writeBigUInt64LE(44n,4);zip64.writeUInt16LE(45,12);zip64.writeUInt16LE(45,14);zip64.writeBigUInt64LE(BigInt(files.length),24);zip64.writeBigUInt64LE(BigInt(files.length),32);zip64.writeBigUInt64LE(BigInt(directory.length),40);zip64.writeBigUInt64LE(BigInt(offset),48);zip64.writeUInt32LE(0x07064b50,56);zip64.writeBigUInt64LE(BigInt(offset+directory.length),64);zip64.writeUInt32LE(1,72);}
    end.writeUInt32LE(0x06054b50);end.writeUInt16LE(wideDirectory?0xffff:files.length,8);end.writeUInt16LE(wideDirectory?0xffff:files.length,10);end.writeUInt32LE(wideDirectory?0xffffffff:directory.length,12);end.writeUInt32LE(wideDirectory?0xffffffff:offset,16);
    return Buffer.concat([...chunks,directory,zip64,end]);
}
