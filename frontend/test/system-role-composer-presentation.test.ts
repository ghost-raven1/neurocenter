import {expect,it} from 'vitest';
import {serviceFeedbackText} from '../src/features/SystemRoleChat/composerPresentation';

it('short feedback stays direct, while long feedback preserves the complete original text',()=>{
    expect(serviceFeedbackText('  Проверьте соединение.  ')).toEqual({summary:'Проверьте соединение.'});
    const value='Проверка отправки недоступна. '.repeat(30)+'\nИсходный запрос сохранён.';
    const result=serviceFeedbackText(value);expect(result.summary.length).toBeLessThanOrEqual(181);expect(result.summary.endsWith('…')).toBe(true);expect(result.detail).toBe(value);
});
it('multiline and Unicode errors keep a full readable disclosure without splitting a character',()=>{
    const lines='Первая строка\nВторая строка\nТретья строка';expect(serviceFeedbackText(lines)).toEqual({summary:'Первая строка Вторая строка Третья строка',detail:lines});
    const value='あ'.repeat(179)+'🌸'+'ещё данные';const result=serviceFeedbackText(value);
    expect(result.summary).toBe('あ'.repeat(179)+'🌸…');expect(result.detail).toBe(value);
});
