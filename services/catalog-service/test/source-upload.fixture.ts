import {createHash,randomUUID} from 'node:crypto';

/** Minimal inspectable Mach-O executable for upload contracts; no fixture code is executed. */
export function executable(){
 const bytes=Buffer.alloc(64);
 bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x100000c,4);bytes.writeUInt32LE(2,12);
 bytes.writeUInt32LE(1,16);bytes.writeUInt32LE(24,20);bytes.writeUInt32LE(0x32,32);
 bytes.writeUInt32LE(24,36);bytes.writeUInt32LE(1,40);
 return bytes;
}

/** A fresh upload request for exactly the bytes supplied by the scenario. */
export const intent=(bytes=executable())=>({requestKey:randomUUID(),name:'program',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
