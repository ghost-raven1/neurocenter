import {expect,it} from 'vitest';
import {publicChatEmbeddingModels} from '../src/features/ChatSemanticSearch/models';
import type {ICatalogModel} from '../src/features/ModelCatalog/types';
const good={id:'model-embedding',name:'Embedding',capability:'embedding',runtime:'remote-openai',dimension:768,modelVersion:'v1',verificationSha256:'a'.repeat(64),modelPin:'b'.repeat(64)} as ICatalogModel;
it('Indexer exposes only assigned exact verified embedding models with the supported dimension',()=>{const rows=[good,{...good,id:'unassigned'},{...good,id:'chat',capability:'chat' as const},{...good,id:'dimension',dimension:20000},{...good,id:'unverified',verificationSha256:null},{...good,id:'archived',archivedAt:'2026-10-24'},{...good,id:'local',runtime:'ollama' as const,manifestSha256:'c'.repeat(64)}];expect(publicChatEmbeddingModels({items:rows,assignedModelIds:rows.filter(value=>value.id!=='unassigned').map(value=>value.id)}).map(value=>value.id)).toEqual(['model-embedding','local']);});
