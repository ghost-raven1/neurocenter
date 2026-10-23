import {spawn} from 'node:child_process';

/** Parent IPC is never inherited by package code. Owner death forcibly stops this exact guardian group. */
function stop() {
    try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}
}
if(!process.send||!process.connected)stop();
process.once('disconnect',stop);process.once('SIGTERM',stop);process.once('SIGINT',stop);
// The trusted wrapper bootstraps with the stripped profile env. Package env arrives only after bootstrap, on private IPC.
process.once('message',message=>{
    try {
        if(message?.type!=='start'||JSON.stringify(message).length>1048576)throw new Error();
        const {command,args,plugin,env}=message;
        if(typeof command!=='string'||!Array.isArray(args)||args.some(argument=>typeof argument!=='string')||typeof plugin!=='boolean'
            ||!env||typeof env!=='object'||Array.isArray(env)||Object.values(env).some(value=>typeof value!=='string'))throw new Error();
        delete env.NODE_CHANNEL_FD;delete env.NODE_CHANNEL_SERIALIZATION_MODE;
        const child=spawn(command,args,{cwd:process.cwd(),env,shell:false,detached:false,stdio:['inherit','inherit','inherit',...(plugin?[3]:[])]});
        child.once('spawn',()=>process.send?.({type:'runtime-started',pid:child.pid}));
        child.once('error',()=>{if(process.connected)process.send({type:'runtime-exit',code:null,signal:null,unavailable:true},stop);else stop();});
        child.once('close',(code,signal)=>{
            // Flush the actual package exit status before killing the guardian itself and any remaining owned processes.
            if(process.connected)process.send({type:'runtime-exit',code,signal},stop);else stop();
        });
    } catch {stop();}
});
