import {spawnSync} from 'node:child_process';
import path from 'node:path';

/** Microsoft taskkill /T /F targets only the numeric PID of this supervisor's own builder. */
export function stopWindowsBuildTree(pid:number):void{
    if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid owned builder PID');
    const root=process.env.SystemRoot||process.env.WINDIR||'C:\\Windows';
    if(!path.win32.isAbsolute(root)||root.includes('\0'))throw Error('Invalid Windows system directory');
    const result=spawnSync(path.win32.join(root,'System32','taskkill.exe'),['/PID',String(pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore',timeout:5000});
    if(result.error||result.status!==0||result.signal)throw Error('Windows builder tree termination is not confirmed');
}
