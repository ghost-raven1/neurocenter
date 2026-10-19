import {describe,expect,it} from 'vitest';
import {errorMessage} from '../src/common/utils/errorMessage';
describe('Сообщения при отказе сервера',()=>{
    it('Общий внутренний сбой заменяется русским действием конкретного экрана',()=>{
        expect(errorMessage({isAxiosError:true,response:{status:500,data:{message:'Internal server error'}}},'База знаний временно недоступна. Повторите загрузку.')).toBe('База знаний временно недоступна. Повторите загрузку.');
    });
    it('Прикладной отказ сохраняет объяснение квоты и путь решения',()=>{
        expect(errorMessage({isAxiosError:true,response:{status:413,data:{message:'Попросите администратора увеличить лимит.'}}},'Сбой')).toBe('Попросите администратора увеличить лимит.');
    });
    it('Сетевой отказ и неподтверждённый ответ не показывают пользователю техническую строку',()=>{
        expect(errorMessage({isAxiosError:true,message:'Network Error'},'Повторите загрузку.')).toBe('Повторите загрузку.');
        expect(errorMessage({isAxiosError:true,response:{data:{message:{internal:'detail'}}}},'Повторите загрузку.')).toBe('Повторите загрузку.');
    });
});
