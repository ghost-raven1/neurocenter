import {describe,expect,it} from 'vitest';
import {auditResourceLabel,describeAuditAction,featureFlagAuditChanges} from '../src/modules/Audit/auditHelpers';

describe('История переключения функций',()=>{
    it('Использует понятное название действия и ресурса',()=>{
        expect(describeAuditAction('feature_flag.update')).toEqual({label:'Переключение функции',color:'blue'});
        expect(auditResourceLabel('feature_flag')).toBe('Функция платформы');
    });
    it('Показывает подтверждённую смену состояния без произвольных полей',()=>{
        expect(featureFlagAuditChanges({before:{enabled:true,secret:'hidden'},after:{enabled:false}})).toEqual([{label:'Состояние',before:'Включено',after:'Выключено'}]);
        expect(featureFlagAuditChanges({before:{enabled:'false'},after:{enabled:false}})).toEqual([]);
        expect(featureFlagAuditChanges({before:{enabled:true},after:{enabled:true}})).toEqual([]);
        expect(featureFlagAuditChanges(undefined)).toEqual([]);
    });
});
