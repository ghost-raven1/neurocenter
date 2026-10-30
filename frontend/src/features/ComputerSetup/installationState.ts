import {OPENCODE_CLI_INSTALL_JOB} from '@neurocenter/opencode-cli-install';
import {OPENCODE_CLI_INSPECT_JOB} from '@neurocenter/computer-setup';
import {readCliJob,record,type CliJob} from './model';

/** Reports are hints until the strict device/job result contract validates them. */
export function latestCliInstallation(values:readonly unknown[],deviceId:string):CliJob|undefined {
    const jobs:CliJob[]=[];
    for(const value of values){
        if(!record(value)||value.deviceId!==deviceId||value.kind!==OPENCODE_CLI_INSTALL_JOB)continue;
        try{jobs.push(readCliJob(value,deviceId,undefined,OPENCODE_CLI_INSTALL_JOB));}catch{/* A malformed receipt never becomes ready. */}
    }
    return jobs.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
}

/** A new explicit fixed inspection resolves current CLI presence without replaying a past publication. */
export function installationReconciled(installation:CliJob,values:readonly unknown[]):boolean {
    return values.some(value=>{
        try{const job=readCliJob(value,installation.deviceId,undefined,OPENCODE_CLI_INSPECT_JOB);
            return !!job.observation&&['installed','missing'].includes(job.observation.status)&&Date.parse(job.createdAt)>Date.parse(installation.updatedAt);}
        catch{return false;}
    });
}

export function laterCliJob(first:CliJob|undefined,second:CliJob|undefined):CliJob|undefined {
    if(!second)return first;if(!first)return second;
    return Date.parse(second.createdAt)>Date.parse(first.createdAt)||second.createdAt===first.createdAt&&Date.parse(second.updatedAt)>Date.parse(first.updatedAt)?second:first;
}
