import { packagingApi } from './api';
import { usePackagingMetadata } from './usePackagingMetadata';

/** Запоздалый ответ предыдущего npm-пакета не меняет карточку нового источника. */
export function useNpmMetadata(specifier: string) {
    const value = specifier.trim();
    return usePackagingMetadata(value, async () => {
        if (!value) throw new Error('Укажите npm-пакет или ссылку на него.');
        return packagingApi.npm(value);
    }, 'Не удалось прочитать пакет. Проверьте название и повторите.');
}
