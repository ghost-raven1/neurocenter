import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export class RuntimeVerificationError extends Error {
    constructor(code) { super(code); this.code=code; }
}

/** A deadline and one owned process group; raw package diagnostics never enter the report. */
export class RuntimeVerificationScope {
    controller=new AbortController();
    children=new Set();
    constructor({signal,timeoutMs,maxOutputBytes}) {
        this.deadline=Date.now()+timeoutMs;this.maxOutputBytes=maxOutputBytes;
        this.abort=()=>this.controller.abort('cancelled');this.externalSignal=signal;
        signal?.addEventListener('abort',this.abort,{once:true});
        if(signal?.aborted)this.abort();
        this.timer=setTimeout(()=>this.controller.abort('timeout'),timeoutMs);
    }
    remaining() {
        if(this.controller.signal.aborted)throw new RuntimeVerificationError(this.controller.signal.reason==='cancelled'?'cancelled':'timeout');
        const left=this.deadline-Date.now();if(left<=0)throw new RuntimeVerificationError('timeout');return left;
    }
    /** Phase transitions may extend only a live scope; cancellation or an expired phase is never revived. */
    resetDeadline(milliseconds) {
        if(this.closed)throw new RuntimeVerificationError('verification-failed');
        this.remaining();clearTimeout(this.timer);this.deadline=Date.now()+milliseconds;
        this.timer=setTimeout(()=>this.controller.abort('timeout'),milliseconds);
    }
    async wait(promise) {
        this.remaining();let listener;
        const aborted=new Promise((_,reject)=>{listener=()=>reject(new RuntimeVerificationError(this.controller.signal.reason==='cancelled'?'cancelled':'timeout'));this.controller.signal.addEventListener('abort',listener,{once:true});});
        try{return await Promise.race([promise,aborted]);}finally{this.controller.signal.removeEventListener('abort',listener);}
    }
    start(command,args,profile,{ipc=false}={}) {
        this.remaining();
        const targetEnvironment=Object.entries(profile.env);
        const launched=profile.adapter==='linux-bwrap'
            ?[...profile.launch.args,'--clearenv',...targetEnvironment.flatMap(([key,value])=>['--setenv',key,value]),'--',command,...args]
            :[...profile.launch.args,'/usr/bin/env','-i',...targetEnvironment.map(([key,value])=>key+'='+value),command,...args];
        const guardian=fileURLToPath(new URL('./verify-runtime-guardian.mjs',import.meta.url));
        const child=spawn(process.execPath,[guardian],{
            cwd:profile.project,env:profile.guardianEnv,detached:true,shell:false,stdio:['pipe','pipe','pipe',ipc?'pipe':'ignore','ipc'],
        });
        child.once('spawn',()=>child.send({type:'start',command:profile.launch.command,args:launched,plugin:ipc,env:profile.guardianEnv},error=>{if(error){child.failure=new RuntimeVerificationError('runtime-unavailable');this.stop(child);}}));
        child.runtimeExitCode=null;
        child.on('message',message=>{
            if(message?.type==='runtime-started'&&Number.isSafeInteger(message.pid))child.runtimePid=message.pid;
            if(message?.type==='runtime-exit'){
                child.runtimeExitCode=Number.isInteger(message.code)?message.code:null;
                if(message.unavailable)child.failure=new RuntimeVerificationError('runtime-unavailable');
            }
        });
        this.children.add(child);child.stdin.on('error',()=>{});
        child.finished=new Promise(resolve=>{const finished=()=>{child.verificationClosed=true;this.children.delete(child);resolve();};child.once('close',finished);child.once('error',finished);});
        let output=0;
        const count=chunk=>{output+=chunk.length;if(output>this.maxOutputBytes){child.failure=new RuntimeVerificationError('output-limit');this.stop(child);}};
        child.stdout.on('data',count);child.stderr.on('data',count);
        child.once('error',()=>{child.failure=new RuntimeVerificationError('runtime-unavailable');});
        return child;
    }
    stop(child) {
        if(child.pid&&!child.verificationClosed)try{process.kill(-child.pid,'SIGKILL');}catch{}
        child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.stdio[3]?.destroy();
    }
    async close() {
        this.closed=true;clearTimeout(this.timer);this.externalSignal?.removeEventListener('abort',this.abort);
        for(const child of this.children)this.stop(child);
        let timer;const completed=Promise.all([...this.children].map(child=>child.finished));
        try{await Promise.race([completed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new RuntimeVerificationError('cleanup-failed')),1000);})]);}
        finally{clearTimeout(timer);this.children.clear();}
    }
}

async function linuxSandbox(root,nodeExecutable) {
    let command;for(const candidate of ['/usr/bin/bwrap','/bin/bwrap'])try{await fs.access(candidate,fs.constants.X_OK);command=candidate;break;}catch{}
    if(!command)throw new RuntimeVerificationError('isolation-unavailable');
    const args=['--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts','--new-session','--die-with-parent',
        '--cap-drop','ALL','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
    for(const system of ['/usr','/bin','/lib','/lib64'])try{await fs.access(system);args.push('--ro-bind',system,system);}catch{}
    if(!['/usr/','/bin/'].some(prefix=>nodeExecutable.startsWith(prefix)))args.push('--ro-bind',nodeExecutable,nodeExecutable);
    args.push('--bind',root,root,'--chdir',path.join(root,'project'));
    return {adapter:'linux-bwrap',launch:{command,args},hostNamespaces:{
        pid:await fs.readlink('/proc/self/ns/pid'),net:await fs.readlink('/proc/self/ns/net')}};
}

/** Mandatory OS enforcement. HOME/cwd relocation alone never authorizes package execution. */
export async function configureRuntimeSandbox(root,nodeExecutable) {
    if(!['darwin','linux'].includes(process.platform))throw new RuntimeVerificationError('isolation-unavailable');
    const home=path.join(root,'home'),project=path.join(root,'project'),temporary=path.join(root,'tmp'),bin=path.join(root,'bin');
    await Promise.all([home,project,temporary,bin].map(directory=>fs.mkdir(directory,{recursive:true,mode:0o700})));
    await fs.writeFile(path.join(root,'package.json'),'{"private":true}',{mode:0o600});
    await fs.writeFile(path.join(project,'package.json'),'{"private":true,"type":"module","scripts":{"test":"unavailable"}}',{mode:0o600});
    const env={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),
        XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),TMPDIR:temporary,TMP:temporary,TEMP:temporary,PATH:bin,
        TERM:'dumb',NO_COLOR:'1',DO_NOT_TRACK:'1',NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',
        NPM_CONFIG_REGISTRY:'http://127.0.0.1:9',NPM_CONFIG_CACHE:path.join(root,'npm-cache'),PIP_NO_INDEX:'1',PIP_DISABLE_PIP_VERSION_CHECK:'1',
        OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_DEFAULT_PLUGINS:'1'};
    if(process.platform==='linux')return {root,home,project,env,guardianEnv:env,...await linuxSandbox(root,nodeExecutable)};
    try{await fs.access('/usr/bin/sandbox-exec',fs.constants.X_OK);}catch{throw new RuntimeVerificationError('isolation-unavailable');}
    // No process-fork: detached grandchildren cannot outlive the owned process group. Node worker threads remain available.
    const policy=path.join(root,'runtime.sb');
    await fs.writeFile(policy,`(version 1)\n(deny default)\n(allow process-exec (literal "/usr/bin/env") (literal ${JSON.stringify(nodeExecutable)}) (subpath ${JSON.stringify(root)}))\n`+
        `(allow file-read* file-map-executable (subpath ${JSON.stringify(root)}) (literal ${JSON.stringify(nodeExecutable)}) (literal "/usr/bin/env") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/Library/Apple/System/Library")\n`+
        ` (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime"))\n`+
        `(allow file-read-metadata (path-ancestors ${JSON.stringify(root)}) (path-ancestors ${JSON.stringify(nodeExecutable)}))\n`+
        `(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))\n(allow sysctl-read)\n`+
        `(allow mach-lookup (global-name "com.apple.system.logger"))\n`,{mode:0o600});
    return {root,home,project,env,guardianEnv:env,policy,adapter:'darwin-seatbelt',launch:{command:'/usr/bin/sandbox-exec',args:['-f',policy]}};
}

/** Proves the OS policy is active before candidate execution; Linux also proves PID/network namespaces differ. */
export async function assertRuntimeSandbox(profile,nodeExecutable,scope) {
    const marker=path.join(profile.root,'sandbox-ready'),script=path.join(profile.root,'sandbox-check.mjs');
    const linux=profile.adapter==='linux-bwrap';
    await fs.writeFile(script,`import fs from 'node:fs';import net from 'node:net';import {spawnSync} from 'node:child_process';
const linux=${linux};
let denied=0;for(const [file,write] of [[linux?'/usr/.neurocenter-runtime-denied':process.execPath+'.denied',true],[linux?'/etc/passwd':'/private/etc/passwd',false]])try{write?fs.writeFileSync(file,'no'):fs.readFileSync(file);}catch(error){if(['EPERM','EACCES',...(linux?['EROFS','ENOENT']:[])].includes(error.code))denied++;}
const fork=spawnSync(process.execPath,['-e','process.exit(0)']);
if(linux){if(fork.error||fork.status!==0||fs.readlinkSync('/proc/self/ns/pid')===${JSON.stringify(profile.hostNamespaces?.pid)}||fs.readlinkSync('/proc/self/ns/net')===${JSON.stringify(profile.hostNamespaces?.net)})process.exit(12);if(denied!==2)process.exit(14);fs.writeFileSync(${JSON.stringify(marker)},'ready');}
else{if(!fork.error||!['EPERM','EACCES'].includes(fork.error.code))process.exit(12);const socket=net.connect({host:'127.0.0.1',port:9});socket.on('connect',()=>process.exit(13));socket.on('error',error=>{if(!['EPERM','EACCES'].includes(error.code)||denied!==2)process.exit(14);fs.writeFileSync(${JSON.stringify(marker)},'ready');});}
`,{mode:0o600});
    const child=scope.start(nodeExecutable,[script],profile);
    await scope.wait(child.finished);
    if(child.failure)throw child.failure;
    try{if(child.runtimeExitCode!==0||await fs.readFile(marker,'utf8')!=='ready')throw new Error();}
    catch{throw new RuntimeVerificationError('isolation-unavailable');}
}
