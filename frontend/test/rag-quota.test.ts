import {beforeEach,describe,expect,it,vi} from 'vitest';
import {formatRagBytes,MEBIBYTE,ragLimitBytes,ragQuotaPercent,requireRagQuota} from '../src/modules/Projects/features/RagQuota/model';
import base from '../src/core/api/base';
import bffApi from '../src/core/api/bff';
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),patch:vi.fn()}}));
const quota={usedBytes:99,limitBytes:100,availableBytes:1,revision:2,maximumBytes:1024};
describe('Достоверный расход базы знаний',()=>{
    it('Лимит и поле ввода используют одинаковые единицы вместо смешения ГБ и ГиБ',()=>{
        expect(formatRagBytes(1024**3)).toBe('1 ГиБ');expect(formatRagBytes(1024**2)).toBe('1 МиБ');
    });
    it('Нулевой и дробный расход читаются с точностью до двух знаков',()=>{
        expect(formatRagBytes(0)).toBe('0 Б');expect(formatRagBytes(1536)).toBe('1,5 КиБ');
    });
    it('Ровная граница и старый лимит выше нового максимума остаются читаемыми',()=>{
        expect(requireRagQuota(quota)).toEqual(quota);
        expect(requireRagQuota({...quota,usedBytes:100,availableBytes:0,maximumBytes:50})).toMatchObject({usedBytes:100});
    });
    it.each([null,{},[],{...quota,usedBytes:-1},{...quota,usedBytes:101},{...quota,availableBytes:2},{...quota,limitBytes:0},{...quota,revision:0.5},{...quota,maximumBytes:Infinity}])('Неверный счётчик %j не превращается в свободное место',input=>{expect(()=>requireRagQuota(input)).toThrow();});
    it('Полоса не показывает полное заполнение до достижения лимита',()=>{
        expect(ragQuotaPercent({...quota,usedBytes:9999,limitBytes:10000})).toBe(99);expect(ragQuotaPercent({...quota,usedBytes:100})).toBe(100);
    });
    it('МиБ переводятся в двоичные байты с точностью до одного байта',()=>{
        expect(ragLimitBytes(1024,1024**3)).toBe(1024**3);expect(ragLimitBytes(1/MEBIBYTE,100)).toBe(1);
    });
    it.each([0,-1,null,undefined,'1',NaN,Infinity,1e20])('Неверный ввод %j не уходит на сервер',value=>{expect(()=>ragLimitBytes(value,1024**3)).toThrow();});
    it('Нельзя сохранить лимит выше разрешённого максимума',()=>{expect(()=>ragLimitBytes(2,MEBIBYTE)).toThrow();});
});
describe('Контракт изменения квоты',()=>{
    beforeEach(()=>vi.resetAllMocks());
    it('Запрос чтения явно связан с выбранным проектом',async()=>{
        vi.mocked(base.get).mockResolvedValue({data:quota});expect(await bffApi.getRagQuota('prj-a')).toEqual(quota);
        expect(base.get).toHaveBeenCalledWith('/api/rag/quota',{params:{projectKey:'prj-a'}});
    });
    it('Сохранение передаёт ревизию и не позволяет payload подменить проект или автора',async()=>{
        vi.mocked(base.patch).mockResolvedValue({data:quota});
        await bffApi.updateRagQuota('prj-a',{limitBytes:100,expectedRevision:2,projectKey:'foreign',actor:'forged'} as never);
        expect(base.patch).toHaveBeenCalledWith('/api/rag/quota',{projectKey:'prj-a',limitBytes:100,expectedRevision:2});
    });
});
