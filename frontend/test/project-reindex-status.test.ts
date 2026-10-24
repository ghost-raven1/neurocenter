import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {ProjectReindexStatus} from '../src/features/ProjectEmbedding/ProjectReindexStatus';
import type {useProjectReindex} from '../src/features/ProjectEmbedding/useProjectReindex';
import type {IProjectReindexPlan} from '../src/features/ProjectEmbedding/reindex';

const render=(localState:string)=>{
    const pending=['pending','queued','running','reconciling'].includes(localState);
    const plan={state:'applied',message:'Server ready',data:{rowCount:1,requiredBytes:100,connection:{}},local:{state:localState,message:'Local '+localState,percent:null}} as unknown as IProjectReindexPlan;
    const state={plan,pending,busy:false,error:''} as ReturnType<typeof useProjectReindex>;
    return renderToStaticMarkup(createElement(ProjectReindexStatus,{state,canManage:false}));
};
describe('One-click reindex outcome includes the selected computer',()=>{
    it('Server-only completion names its scope without claiming a checked computer index',()=>{
        const plan={state:'applied',message:'Server ready',data:{rowCount:0,requiredBytes:0}} as IProjectReindexPlan;
        const state={plan,pending:false,busy:false,error:''} as ReturnType<typeof useProjectReindex>;
        const html=renderToStaticMarkup(createElement(ProjectReindexStatus,{state,canManage:false}));
        expect(html).toContain('Этот результат относится к серверному индексу.');
        expect(html).not.toContain('Локальный индекс проверен и синхронизирован.');
    });
    it.each(['pending','queued','running','reconciling'])('Server promotion with local %s is progress, never success',state=>{
        expect(render(state)).toContain('ant-alert-info');expect(render(state)).not.toContain('ant-alert-success');
    });
    it('Only completed local work is green; a failed local step stays a warning',()=>{
        expect(render('succeeded')).toContain('ant-alert-success');expect(render('failed')).toContain('ant-alert-warning');
    });
    it('Completed local reindex explains restart; pending or failed work does not claim a checked index',()=>{
        const complete=render('succeeded');expect(complete).toContain('Локальный индекс проверен и синхронизирован.');expect(complete).toContain('Перезапустите OpenCode, чтобы открытая сессия использовала новое подключение');
        expect(complete).not.toContain('Этот результат относится к серверному индексу.');
        expect(complete).not.toContain('Прежний локальный индекс сохранится до проверки нового.');
        for(const state of ['pending','queued','running','reconciling','failed']){
            const html=render(state);expect(html).toContain('Прежний локальный индекс сохранится до проверки нового.');expect(html).not.toContain('Локальный индекс проверен и синхронизирован.');expect(html).not.toContain('Перезапустите OpenCode');
        }
    });
});
