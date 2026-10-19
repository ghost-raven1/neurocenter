import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAuditRefresh } from '../src/modules/Audit/auditRefresh';

let visibility: DocumentVisibilityState;
beforeEach(() => {
    vi.useFakeTimers();
    visibility='visible';
    vi.stubGlobal('document',{get visibilityState() { return visibility; }});
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Фоновое обновление открытой истории', () => {
    it('Перечитывает историю каждые десять секунд и освобождает таймер при закрытии', () => {
        const refresh=vi.fn();
        const stop=startAuditRefresh(()=>({refresh,loading:false}));
        vi.advanceTimersByTime(9999);
        expect(refresh).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(refresh).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(10000);
        expect(refresh).toHaveBeenCalledTimes(2);
        stop();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(20000);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('Не запрашивает историю в скрытой вкладке и возобновляет запросы после возвращения', () => {
        const refresh=vi.fn();
        const stop=startAuditRefresh(()=>({refresh,loading:false}));
        visibility='hidden';
        vi.advanceTimersByTime(30000);
        expect(refresh).not.toHaveBeenCalled();
        visibility='visible';
        vi.advanceTimersByTime(10000);
        expect(refresh).toHaveBeenCalledOnce();
        stop();
    });

    it('Берёт текущую страницу и пропускает опрос во время незавершённого запроса', () => {
        const first=vi.fn();const second=vi.fn();
        let current={refresh:first,loading:false};
        const stop=startAuditRefresh(()=>current);
        current={refresh:second,loading:true};
        vi.advanceTimersByTime(10000);
        expect(first).not.toHaveBeenCalled();expect(second).not.toHaveBeenCalled();
        current={refresh:second,loading:false};
        vi.advanceTimersByTime(10000);
        expect(first).not.toHaveBeenCalled();expect(second).toHaveBeenCalledOnce();
        stop();
    });
});
