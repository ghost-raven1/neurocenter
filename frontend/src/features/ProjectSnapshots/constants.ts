import type { TSnapshotIntent } from './interfaces';

export const snapshotActionLabel: Record<TSnapshotIntent['kind'], string> = {
    create: 'Создание снимка',
    activate: 'Активация снимка',
    rollback: 'Откат серверного снимка',
    delete: 'Удаление снимка',
    cancel: 'Отмена публикации',
    release: 'Выпуск релизного профиля',
};
