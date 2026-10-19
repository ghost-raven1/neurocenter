import { beforeEach, describe, expect, it, vi } from 'vitest';

import base from '../src/core/api/base';
import bffApi from '../src/core/api/bff';

vi.mock('../src/core/api/base', () => ({ default: { post: vi.fn() } }));

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
});
