import {describe,expect,it} from 'vitest';
import {projectReadUnavailable} from '../src/modules/Projects/projectReadError';

describe('Прежние сведения после отказа чтения проекта',()=>{
    it.each([403,404])('HTTP %s скрывает сохранённые данные и действия проекта',status=>{
        expect(projectReadUnavailable({isAxiosError:true,response:{status}})).toBe(true);
    });
    it.each([400,409,429,500,502,503])('HTTP %s без отзыва доступа сохраняет последние данные с предупреждением',status=>{
        expect(projectReadUnavailable({isAxiosError:true,response:{status}})).toBe(false);
    });
    it('Сетевая ошибка не означает отзыв прав, обычный объект не считается HTTP ответом',()=>{
        expect(projectReadUnavailable({isAxiosError:true})).toBe(false);
        expect(projectReadUnavailable(new Error('Network Error'))).toBe(false);
        expect(projectReadUnavailable({response:{status:403}})).toBe(false);
    });
});
