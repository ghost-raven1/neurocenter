import {createHash} from 'node:crypto';
import {ragRequestHash,type IIndexProfile} from '../../shared/rag-index-contract.cjs';
import type {RagService} from '../src/rag/rag.service';

export const fixtureProfile={provider:'openai',model:'neurocenter/model-fixture/sha256/'+'a'.repeat(64),dimension:2560};
export const generation=(project='project')=>'initial-'+createHash('md5').update(project).digest('hex');
/** Полный новый wire-envelope позволяет отрицательным тестам изолировать именно повреждённое поле. */
export function write(chunks:unknown=[],deletes:unknown=[],profile:IIndexProfile=fixtureProfile,snapshot?:unknown):Parameters<RagService['applyDelta']>[0]{
    const context={projectId:'project',generation:generation(),revision:1,dataRevision:0,profile,snapshot:null};
    const payload={projectKey:'project',expectedGeneration:context.generation,expectedSelectionRevision:1,expectedDataRevision:0,
        requestKey:'b'.repeat(64),fingerprintVersion:1,indexProfile:profile,snapshot:snapshot??{hash:'c'.repeat(64),rowCount:1,complete:false},chunks,deletes};
    return {id:'11111111-1111-4111-a111-111111111111',context,payload,payloadHash:ragRequestHash(payload)};
}
