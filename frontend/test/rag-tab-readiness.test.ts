import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import RagTab from '../src/modules/Projects/components/RagTab';
import {ragSummaryState} from '../src/modules/Projects/components/ragSummaryState';
import {currentKnowledgeJobs} from '../src/features/McpBridge/knowledgeSyncState';
import type {IRagSummary} from '../src/core/api/interfaces';
import type {IBridgeJob} from '../src/features/McpBridge/api';

vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]}}})}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:vi.fn()}));
vi.mock('../src/features/McpBridge/KnowledgeSync',()=>({KnowledgeSync:({projectId,serverReady}:{projectId:string;serverReady?:boolean})=>
    createElement('div',{'data-knowledge-sync':projectId,'data-server-ready':serverReady===undefined?'unknown':String(serverReady)})}));
const summary:IRagSummary={projectKey:'project',rowCount:3,dimension:4,lastSyncedAt:null,usableVectorCount:3,incompleteRows:0,
    fingerprintVersion:1,indexProfile:{provider:'ollama',model:'fixture',dimension:4},complete:true,indexState:'ready',snapshotHash:'a'.repeat(64)};

describe('Подготовка знаний не зависит от доступности серверной сводки',()=>{
    it('До загрузки сводки доступны установка плагина и подключение моста',()=>{
        const html=renderToStaticMarkup(createElement(RagTab,{projectKey:'project'}));
        expect(html).toContain('Установить OpenCodeRAG');expect(html).toContain('data-knowledge-sync="project"');
        expect(html).toContain('Настройка модели и индекса');expect(html).not.toContain('Заиндексирован');
        expect(html).toContain('data-server-ready="unknown"');
        expect(html).toContain('закройте OpenCode');
    });
    it('Одни серверные строки не подтверждают работоспособность модели или индекса',()=>{
        expect(ragSummaryState({projectKey:'project',rowCount:3,dimension:4,lastSyncedAt:null})).toEqual({title:'Копия не проверена',verified:false});
        expect(ragSummaryState(summary)).toEqual({title:'Копия проверена',verified:true});
    });
    it.each([{complete:false},{usableVectorCount:2},{incompleteRows:1},{indexProfile:null},{snapshotHash:null},{indexState:'syncing' as const},
        {fingerprintVersion:0},{indexProfile:{provider:'ollama',model:'fixture',dimension:5}}])('Неполная копия не получает проверенный статус: %j',change=>{
        expect(ragSummaryState({...summary,...change}).verified).toBe(false);
    });
    it('Успех прежней папки не становится текущим результатом синхронизации',()=>{
        const job:IBridgeJob={id:'job',deviceId:'device',projectId:'project',kind:'sync-rag',state:'succeeded',message:'Готово',bindingId:'old',createdAt:'',updatedAt:''};
        expect(currentKnowledgeJobs([job],'device','project','new')).toEqual([]);
        expect(currentKnowledgeJobs([job,{...job,id:'current',bindingId:'new'}],'device','project','new').map(row=>row.id)).toEqual(['current']);
    });
});
