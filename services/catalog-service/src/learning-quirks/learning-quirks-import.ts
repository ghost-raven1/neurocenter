import type {QuirkEntry,QuirksReceipt,QuirksSnapshot} from '../../../shared/project-learning-quirks.cjs';

/** A late failure preserves every committed immutable observation and returns an explicit retry receipt. */
export async function importQuirkSnapshot(snapshot:QuirksSnapshot,append:(entry:QuirkEntry)=>Promise<boolean>,authorize:()=>Promise<void>):Promise<QuirksReceipt>{
    let imported=0,skipped=0;
    try{
        await authorize();
        for(const entry of snapshot.records){await authorize();if(await append(entry))imported++;else skipped++;}
        await authorize();
        return {schemaVersion:1,status:'complete',sourceCount:snapshot.records.length,imported,skipped,remaining:0,fileSha256:snapshot.fileSha256,safeRetry:true};
    }catch(error){
        if(!imported&&!skipped&&!(error as {partialPossible?:boolean})?.partialPossible)throw error;
        return {schemaVersion:1,status:'partial',sourceCount:snapshot.records.length,imported,skipped,remaining:snapshot.records.length-imported-skipped,fileSha256:snapshot.fileSha256,safeRetry:true};
    }
}
