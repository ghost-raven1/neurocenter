import { message } from 'antd';
import type { ISkillMutationReceipt } from '../../core/api/interfaces';

/** Ожидание аудита не превращает уже сохранённое изменение в ошибку. */
export function notifySkillMutation(result: ISkillMutationReceipt, successText: string, action: 'save' | 'delete' | 'directory' = 'save'): void {
    if (result.audit?.state === 'pending') {
        const saved = action === 'delete' ? 'Скилл удалён.' : action === 'directory' ? 'Папка создана.' : 'Изменения сохранены.';
        void message.warning(`${saved} Ожидается подтверждение аудита.`, 8);
        return;
    }
    void message.success(successText);
}
