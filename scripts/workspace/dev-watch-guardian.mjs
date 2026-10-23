import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stopWatchGroup} from './dev-watch-owned.mjs';
import {writeWatchFile} from './dev-watch-files.mjs';
let started=false,ready=false,child,root,stopping=false;const groups=new Map();
const cleanup=async(failed=false)=>{if(stopping)return;stopping=true;
    if(child?.exitCode===null&&child?.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}
    const results=await Promise.allSettled([...groups.values()].map(record=>stopWatchGroup(record)));
    if(root)await writeWatchFile(root,'status.json',{schemaVersion:1,pid:process.pid,phase:failed?'watch-failed':'stopped',cleanup:results.every(result=>result.status==='fulfilled')}).catch(()=>{});
    process.exitCode=failed||results.some(result=>result.status==='rejected')?1:0;if(process.connected)process.disconnect();
};
process.once('SIGTERM',()=>void cleanup());process.once('SIGINT',()=>void cleanup());process.once('disconnect',()=>{if(!ready)void cleanup(true);});
process.on('message',message=>{if(started||message?.kind!=='start')return;started=true;root=message.config.root;
    child=spawn(process.execPath,[fileURLToPath(new URL('./dev-watch-daemon.mjs',import.meta.url))],{cwd:root,env:process.env,stdio:['ignore','inherit','inherit','ipc']});
    child.on('message',value=>{if(value?.kind==='group'&&Number.isSafeInteger(value.record?.pid)&&value.record.pid>0&&value.record.identity)groups.set(value.record.pid,value.record);
        else if(value?.kind==='release')groups.delete(value.pid);
        else if(value?.kind==='ready'){ready=true;if(process.connected)process.send(value);}
        else if(value?.kind==='failed'&&process.connected)process.send(value);
    });
    child.once('error',()=>void cleanup(true));child.once('exit',code=>{if(!stopping)void cleanup(code!==0||ready);});child.send(message);
});
