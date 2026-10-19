const {test}=require('node:test');
const assert=require('node:assert/strict');
const {defaultPolicy,validateMaintenancePolicy,nextMaintenanceRun,dueMaintenanceRun}=require('../../services/shared/maintenance-policy.cjs');
const policy=extra=>({...structuredClone(defaultPolicy),enabled:true,...extra});
test('Настройки проверяют пояс, окна и целочисленные ограничения',()=>{
    assert.deepEqual(validateMaintenancePolicy(defaultPolicy),defaultPolicy);
    for(const change of [{timeZone:'bad/zone'},{rpoMinutes:0},{localCopies:101},{maxPauseMinutes:1},{windows:[]},{unknown:true},{schedule:{days:[1,1],time:'02:00'}},{schedule:{days:[1],time:'23:00'}}]){assert.throws(()=>validateMaintenancePolicy(policy(change)));}
});
test('Расписание применяется в выбранном часовом поясе',()=>{assert.equal(nextMaintenanceRun(policy({timeZone:'Asia/Tomsk'}),'2026-10-18T18:59:00Z').at,'2026-10-18T19:00:00.000Z');assert.equal(nextMaintenanceRun(defaultPolicy),null);});
test('Окно через полночь учитывает день начала и оставшуюся паузу',()=>{
    const p=policy({schedule:{days:[2],time:'00:30'},windows:[{days:[1],start:'23:00',end:'01:30'}]});validateMaintenancePolicy(p);
    assert.ok(dueMaintenanceRun(p,new Date('2026-10-20T00:45:00Z')));assert.equal(dueMaintenanceRun(p,new Date('2026-10-20T01:15:00Z')),null);
});
test('Отсутствующий час DST пропускается, повторный слот исключается',()=>{
    const p=policy({timeZone:'America/New_York',schedule:{days:[7],time:'02:30'},windows:[{days:[7],start:'00:00',end:'06:00'}]});
    assert.equal(nextMaintenanceRun(p,'2026-03-08T06:00:00Z').at,'2026-03-15T06:30:00.000Z');
    p.schedule.time='01:30';const first=nextMaintenanceRun(p,'2026-11-01T04:00:00Z');assert.equal(first.at,'2026-11-01T05:30:00.000Z');assert.equal(nextMaintenanceRun(p,first.at,first.slot).at,'2026-11-08T06:30:00.000Z');
});
test('Пропущенный запуск не выполняется до расписания или за пределами окна',()=>{assert.equal(dueMaintenanceRun(policy(),new Date('2026-10-18T01:59:00Z')),null);assert.ok(dueMaintenanceRun(policy(),new Date('2026-10-18T02:30:00Z')));assert.equal(dueMaintenanceRun(policy(),new Date('2026-10-18T04:45:00Z')),null);});

test('Catch-up не создаёт несуществовавший локальный слот при весеннем DST',()=>{
    const p=policy({timeZone:'America/New_York',schedule:{days:[7],time:'02:30'},windows:[{days:[7],start:'00:00',end:'06:00'}]});
    assert.equal(dueMaintenanceRun(p,new Date('2026-03-08T07:05:00Z')),null);
    assert.ok(dueMaintenanceRun(p,new Date('2026-03-15T07:05:00Z')));
});
test('Пауза измеряется реальным временем и не выходит за укороченное DST-окно',()=>{
    const p=policy({timeZone:'America/New_York',schedule:{days:[7],time:'01:00'},windows:[{days:[7],start:'01:00',end:'03:00'}],maxPauseMinutes:120});
    validateMaintenancePolicy(p);assert.equal(dueMaintenanceRun(p,new Date('2026-03-08T06:00:00Z')),null);
    assert.equal(nextMaintenanceRun(p,'2026-03-08T05:59:00Z').at,'2026-03-15T05:00:00.000Z');
    p.maxPauseMinutes=60;assert.ok(dueMaintenanceRun(p,new Date('2026-03-08T06:00:00Z')));assert.equal(dueMaintenanceRun(p,new Date('2026-03-08T06:00:01Z')),null);
});
test('Повторный час DST не разрешает паузе пройти через запрещённый локальный промежуток',()=>{
    const p=policy({timeZone:'America/New_York',schedule:{days:[7],time:'01:30'},windows:[{days:[7],start:'01:30',end:'01:45'}],maxPauseMinutes:10});
    validateMaintenancePolicy(p);assert.equal(dueMaintenanceRun(p,new Date('2026-11-01T05:40:00Z')),null);assert.ok(dueMaintenanceRun(p,new Date('2026-11-01T06:30:00Z')));
});
