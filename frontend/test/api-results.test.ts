import { beforeEach, describe, expect, it, vi } from 'vitest';

import base from '../src/core/api/base';
import bffApi from '../src/core/api/bff';
import {webRestoreApi} from '../src/modules/Maintenance/restore/api';

vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn(),get:vi.fn() } }));

describe('Достоверные результаты операций', () => {
    beforeEach(() => { vi.resetAllMocks(); });

    it('Ответ HTTP 200 с пустой RAG-базой остаётся ошибкой операции', async () => {
        vi.mocked(base.post).mockResolvedValue({data:{ok:false,error:'empty-source'}});
        await expect(bffApi.restoreLocalRag('demo')).rejects.toThrow('На сервере пока нет данных');
    });

    it('Отказ первичной синхронизации не превращается в успешный bootstrap', async () => {
        vi.mocked(base.post).mockResolvedValue({data:{ok:false,message:'База недоступна'}});
        await expect(bffApi.bootstrapRag('demo')).rejects.toThrow('База недоступна');
    });

    it('Сохраняет фактический результат успешного восстановления', async () => {
        const data={ok:true,written:3,deleted:1};
        vi.mocked(base.post).mockResolvedValue({data});
        expect(await bffApi.restoreLocalRag('demo')).toEqual(data);
    });

    it('Передаёт квоты нового проекта под именем, ожидаемым сервером', async () => {
        vi.mocked(base.post).mockResolvedValue({data:{id:'demo'}});
        const quota={currentBytesLimit:20,currentBytesUsed:0,retentionBytesLimit:0,retentionBytesUsed:0,stagingBytesLimit:0,stagingBytesUsed:0};
        await bffApi.createProject({name:'demo',externalResourceId:'',retention:30,quota});
        expect(base.post).toHaveBeenCalledWith('/api/projects',{name:'demo',externalResourceId:'',retention:30,quotas:quota});
    });
    it('Простое создание проекта использует серверные значения без фиктивной квоты',async()=>{
        vi.mocked(base.post).mockResolvedValue({data:{id:'demo'}});
        await bffApi.createProject({name:'demo',externalResourceId:''});
        expect(base.post).toHaveBeenCalledWith('/api/projects',{name:'demo',externalResourceId:''});
    });
    it('Чтение действующей истории инструмента сохраняет точные серверные версии',async()=>{
        const versions=[{version:5,files:[]},{version:2,files:[]}];vi.mocked(base.get).mockResolvedValue({data:versions});
        expect(await bffApi.listAiPluginVersions('tool/one')).toEqual(versions);
        expect(base.get).toHaveBeenCalledWith('/api/ai-plugins/tool%2Fone/versions');expect(base.post).not.toHaveBeenCalled();
    });
    it('Восстановление использует сохранённое подтверждение нового feature API без старого checkpoint-only тела',async()=>{
        const intent={kind:'restore' as const,input:{requestKey:crypto.randomUUID(),previewId:crypto.randomUUID(),digest:'a'.repeat(64),confirmation:'RESTORE nc-recovery-one'}},job={id:'confirmed',state:'queued'};
        vi.mocked(base.post).mockResolvedValue({data:job});expect(await webRestoreApi.submit(intent)).toEqual(job);
        expect(base.post).toHaveBeenCalledWith('/api/maintenance/restore',intent.input);
    });
});
