import {execFileSync} from 'node:child_process';

export function ownedProcessSnapshot(){
    return new Map(execFileSync('ps',['-axo','pid=,ppid=,pgid=,lstart='],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{
        const [pid,parent,group,...stamp]=line.trim().split(/\s+/);return [Number(pid),{pid:Number(pid),parent:Number(parent),group:Number(group),stamp:stamp.join(' ')}];
    }));
}

/** A reused PID never inherits ownership; descendants are admitted only through a current owned parent. */
export function observeOwnedProcesses(known,rows,roots=[]){
    for(const pid of roots)if(!known.has(pid)&&rows.has(pid))known.set(pid,rows.get(pid));
    const live=new Map([...known].filter(([pid,record])=>rows.get(pid)?.stamp===record.stamp));
    let added;do{added=false;for(const [pid,record]of rows)if(!known.has(pid)&&live.has(record.parent)){known.set(pid,record);live.set(pid,record);added=true;}}while(added);
    return live;
}

/** Detached fixture groups are eligible only while an observed member still has the same birth stamp. */
export function ownedGroupsToSignal(known,rows){
    const groups=new Set();
    for(const [pid,record]of known){
        const current=rows.get(pid);
        const leader=known.get(record.group);
        if(current?.stamp===record.stamp&&current.group===record.group&&record.group>1&&leader?.group===record.group)groups.add(record.group);
    }
    return [...groups];
}
