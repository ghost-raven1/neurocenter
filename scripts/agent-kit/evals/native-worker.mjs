import fs from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';

// Fixed host wrapper: stdout/stderr stay separate while the existing supervisor owns the whole group.
const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(typeof request.executable!=='string'||!path.isAbsolute(request.executable))throw Error('An absolute native CLI path is required.');
const output=fs.openSync(request.stdout,'wx',0o600),error=fs.openSync(request.stderr,'wx',0o600);
let bytes=0;
const write=(fd,chunk)=>{
    const count=Math.min(chunk.length,4*1024**2-bytes);let offset=0;
    while(offset<count)offset+=fs.writeSync(fd,chunk,offset,count-offset);
    bytes+=count;
    if(count<chunk.length)process.exit(75); // Existing group supervisor reaps the remaining native descendants.
};
try{
    const child=spawn(request.executable,request.args,{cwd:request.cwd,env:process.env,stdio:['pipe','pipe','pipe']});
    child.stdout.on('data',chunk=>write(output,chunk));child.stderr.on('data',chunk=>write(error,chunk));
    child.stdin.on('error',()=>{});child.stdin.end(request.input);
    let leaderDeadline;
    child.once('exit',code=>{leaderDeadline=setTimeout(()=>process.exit(code??1),100);});
    const code=await new Promise(resolve=>{child.once('error',()=>resolve(127));child.once('close',value=>resolve(value??1));});
    clearTimeout(leaderDeadline);
    process.exitCode=code;
}finally{fs.closeSync(output);fs.closeSync(error);}
