import { describe, expect, it, vi } from 'vitest';

import { SnapshotCommandsController } from '../src/catalog/snapshot-commands.controller';
import { CatalogService } from '../src/catalog/catalog.service';

describe('Незавершённые операции', () => {
    const controller = new SnapshotCommandsController();

    it.each([
        () => controller.activateHead('p', 's'),
        () => controller.rollbackHead('p', 's'),
        () => controller.deleteSnapshot('p', 's'),
        () => controller.releaseProfile('p'),
    ])('Незавершённая команда возвращает HTTP 501', (run) => {
        expect(run).toThrow(expect.objectContaining({ status: 501 }));
    });

    it('Восстановление не записывает успех без восстановления данных', async () => {
        const service = new CatalogService();
        const createOperation = vi.spyOn(service['db'], 'createOperation').mockRejectedValue(new Error('unexpected write'));

        try {
            await expect(service.restore()).rejects.toMatchObject({ status: 501 });
            expect(createOperation).not.toHaveBeenCalled();
        } finally {
            await service.onModuleDestroy();
        }
    });
    it.each(['retryOperation','cancelOperation'] as const)('Команда %s не подменяет исполнение изменением журнала',async method=>{
        const service=new CatalogService();vi.spyOn(service,'getOperation').mockResolvedValue({operationId:'test'} as never);const update=vi.spyOn(service['db'],'setOperationState');
        try{await expect(service[method]('test')).rejects.toMatchObject({status:501});expect(update).not.toHaveBeenCalled();}finally{await service.onModuleDestroy();}
    });
});
