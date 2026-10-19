// SIGKILL применяется только к собственным дочерним процессам с отдельной временной папкой.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));const require=createRequire(path.join(root,'services/skills-service/package.json'));
const {FsSkillsStorage}=require(path.join(root,'services/skills-service/dist/storage/fs-skills-storage.js'));const {SkillsService}=require(path.join(root,'services/skills-service/dist/skills/skills.service.js'));
const initial=[{slug:'first',name:'Первый помощник',body:'Исходная первая инструкция',version:1},{slug:'second',name:'Второй помощник',body:'Исходная вторая инструкция',version:1}];
const next=initial.map(item=>({...item,version:2,body:'Новая инструкция: '+item.slug}));
if(process.argv[2]==='--child'){
    const storage=new FsSkillsStorage(process.argv[3]);const service=new SkillsService(storage);const mode=process.argv[4];
    if(mode==='partial'){
        const write=storage.writeSkill.bind(storage);let count=0;
        storage.writeSkill=async(...args)=>{await write(...args);if(++count===1){process.send({stage:'first-file-written'});await new Promise(()=>{process.on('message',()=>undefined);});}};
        await service.syncSkills('crash',next);
    }else if(mode==='committed'){
        const remove=fs.rm.bind(fs);fs.rm=async(...args)=>{const file=String(args[0]);if(file.endsWith('.json')&&path.basename(path.dirname(file))==='.neurocenter-sync-journal'){
            const journal=JSON.parse(await fs.readFile(file,'utf8'));if(journal.state==='committed'){process.send({stage:'commit-marker-written'});await new Promise(()=>{process.on('message',()=>undefined);});}
        }return remove(...args);};
        await service.syncSkills('crash',next);
    }else if(mode==='atomic-edit'){
        const write=fs.writeFile.bind(fs);fs.writeFile=async(...args)=>{await write(...args);if(String(args[0]).endsWith('.tmp')){process.send({stage:'temporary-file-written'});await new Promise(()=>{process.on('message',()=>undefined);});}};
        await service.updateSkill('project-edit/helper',{expectedVersion:1,body:'Новая одиночная инструкция'},'editor');
    }else{
        await service.onApplicationBootstrap();
        if(mode==='retry'){await service.syncSkills('crash',next);}
        process.send({stage:'read',bodies:await Promise.all(initial.map(item=>service.getSkill('project-crash/'+item.slug).then(file=>file.body)))});process.disconnect();
    }
}else{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-server-crash-'));const storage=new FsSkillsStorage(directory);const service=new SkillsService(storage);const results=[];const children=new Set();
    async function child(mode,stage,kill=false){
        const worker=fork(fileURLToPath(import.meta.url),['--child',directory,mode],{stdio:['ignore','ignore','pipe','ipc']});children.add(worker);let diagnostics='';worker.stderr.on('data',chunk=>{diagnostics+=String(chunk).slice(0,1000);});
        const closed=new Promise(resolve=>worker.once('close',(code,signal)=>{children.delete(worker);resolve({code,signal});}));
        const message=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Процесс не достиг контрольной точки: '+mode)),10000);worker.on('message',message=>{if(message.stage===stage){clearTimeout(timeout);resolve(message);}});worker.once('error',error=>{clearTimeout(timeout);reject(error);});worker.once('exit',code=>{clearTimeout(timeout);if(code){reject(new Error('Ошибка дочернего процесса: '+diagnostics));}});});
        if(kill){worker.kill('SIGKILL');const stopped=await closed;assert.equal(stopped.signal,'SIGKILL');}else{assert.equal((await closed).code,0);}return message;
    }
    try{
        await service.syncSkills('crash',initial);await child('partial','first-file-written',true);
        const restarted=await child('read','read');
        const wholeOld=restarted.bodies.every((body,index)=>body===initial[index].body);const wholeNew=restarted.bodies.every((body,index)=>body===next[index].body);
        results.push({case:'Перезапуск после SIGKILL между двумя файлами восстанавливает согласованный пакет',ok:wholeOld||wholeNew,knownGap:!wholeOld&&!wholeNew,observed:restarted.bodies});
        const retried=await child('retry','read');assert.deepEqual(retried.bodies,next.map(item=>item.body));results.push({case:'Явный повтор прерванной синхронизации доводит пакет до одной версии',ok:true});
        await service.createSkill({path:'project-edit',slug:'helper',name:'Помощник редактора',body:'Исходная одиночная инструкция'},'owner');
        await child('atomic-edit','temporary-file-written',true);const current=await service.getSkill('project-edit/helper');assert.equal(current.body,'Исходная одиночная инструкция');assert.equal(current.meta.version,1);assert.equal((await service.listSkills({path:'project-edit'})).length,1);
        results.push({case:'SIGKILL до rename одиночного файла сохраняет исходную инструкцию и версию',ok:true});
        await fs.rm(path.join(directory,'project-crash'),{recursive:true});await service.syncSkills('crash',initial);
        await child('committed','commit-marker-written',true);const committed=await child('read','read');assert.deepEqual(committed.bodies,next.map(item=>item.body));results.push({case:'SIGKILL после commit сохраняет новый пакет при перезапуске',ok:true});
        await fs.rm(path.join(directory,'project-crash'),{recursive:true});await service.syncSkills('crash',initial);
        await child('partial','first-file-written',true);await service.updateSkill('project-crash/second',{expectedVersion:1,body:'Ручная правка после обрыва'},'editor');
        await assert.rejects(child('read','read'),/Автоматический откат остановлен/);assert.equal((await service.getSkill('project-crash/second')).body,'Ручная правка после обрыва');assert.equal((await service.getSkill('project-crash/first')).body,next[0].body);
        assert.equal((await fs.readdir(path.join(directory,'.neurocenter-sync-journal'))).filter(name=>name.endsWith('.json')).length,1);results.push({case:'Ручная правка после SIGKILL блокирует откат всего пакета и сохраняет журнал',ok:true});
    }catch(error){results.push({case:'Проверка процессов и восстановления',ok:false,error:error.message});}
    finally{for(const worker of children){worker.kill('SIGKILL');}await fs.rm(directory,{recursive:true,force:true});}
    const report={results,passed:results.filter(row=>row.ok).length,knownGaps:results.filter(row=>row.knownGap).length,failed:results.filter(row=>!row.ok&&!row.knownGap).length};await fs.mkdir(path.join(root,'.run/qa-continue'),{recursive:true});await fs.writeFile(path.join(root,'.run/qa-continue/skills-process-faults.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.failed){process.exitCode=1;}
}
