import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';

/** Capture only the trace's stdout syscall; no file, PostgreSQL or provider is opened. */
export function captureDevTrace(){
    const launchId=randomUUID(),lines:string[]=[];
    vi.stubEnv('NEUROCENTER_DEV_TRACES','1');vi.stubEnv('NEUROCENTER_DEV_LAUNCH_ID',launchId);
    const write=vi.spyOn(fs,'writeSync').mockImplementation(((descriptor:number,value:unknown)=>{
        if(descriptor!==process.stdout.fd)throw Error('Unexpected fixture descriptor');
        lines.push(String(value));return Buffer.byteLength(String(value));
    }) as typeof fs.writeSync);
    return {launchId,write,records:()=>lines.map(line=>JSON.parse(line) as Record<string,string|number>)};
}

export function deferred(){
    let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};
}
