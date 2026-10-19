import {describe,expect,it} from 'vitest';
import {formatScheduledBackup} from '../src/modules/Maintenance/maintenancePolicy';
import {maintenanceAuditChanges} from '../src/modules/Audit/auditHelpers';
describe('Расписание и аудит обслуживания',()=>{
    it('Плановое время использует выбранный пояс, а не пояс браузера',()=>{expect(formatScheduledBackup('2026-10-18T02:00:00Z','UTC')).toContain('02:00');expect(formatScheduledBackup('2026-10-18T02:00:00Z','Asia/Tomsk')).toContain('09:00');});
    it('История показывает только изменённые известные настройки без посторонних значений',()=>{expect(maintenanceAuditChanges({before:{policy:{enabled:false,rpoMinutes:1440}},after:{policy:{enabled:true,rpoMinutes:1440,secret:'never-render'}}})).toEqual([{label:'Расписание',before:'Выключено',after:'Включено'}]);});
});
