import { ConflictException } from '@nestjs/common';
import type { IModelDescriptor } from './model.types';

interface ISuppliedModel { id: string; name: string; descriptor: IModelDescriptor }

/** Совпадение имени не блокирует запуск другого сервера; ID и технические параметры не подменяются. */
export function modelSupplySeeds(supply: ReadonlyArray<ISuppliedModel>, current: ReadonlyArray<ISuppliedModel>): ISuppliedModel[] {
    const existing = new Map(current.map(item => [item.id, item]));
    for (const item of supply) {
        const previous = existing.get(item.id);
        if (previous && (['model', 'runtime', 'capability', 'dimension'] as const).some(key => previous.descriptor[key] !== item.descriptor[key])) {
            throw new ConflictException(`Поставка модели ${item.id} конфликтует с техническими параметрами существующей карточки. Создайте отдельную карточку; данные каталога сохранены.`);
        }
    }
    const names = new Set(current.map(item => item.name.toLowerCase()));
    return supply.map(item => {
        const previous = existing.get(item.id);
        if (previous) { return { ...item, name: previous.name }; }
        let name = item.name;
        for (let attempt = 0; names.has(name.toLowerCase()); attempt++) {
            const suffix = ` · ${item.id}${attempt ? ` · ${attempt + 1}` : ''}`;
            name = suffix.length >= 128 ? suffix.slice(-128) : item.name.slice(0, 128 - suffix.length) + suffix;
        }
        names.add(name.toLowerCase());
        return { ...item, name };
    });
}
