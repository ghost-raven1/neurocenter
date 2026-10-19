'use strict';
const timePattern=/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const defaultPolicy={enabled:false,timeZone:'UTC',schedule:{days:[1,2,3,4,5,6,7],time:'02:00'},windows:[{days:[1,2,3,4,5,6,7],start:'01:00',end:'05:00'}],maxPauseMinutes:30,localCopies:5,externalRetentionDays:30,rpoMinutes:1440,rtoMinutes:240};
const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key))){throw new Error('Некорректные поля настроек обслуживания');}}
function days(value){if(!Array.isArray(value)||!value.length||value.length>7||value.some(day=>!Number.isInteger(day)||day<1||day>7)||new Set(value).size!==value.length){throw new Error('Выберите неповторяющиеся дни недели');}return [...value].sort((a,b)=>a-b);}
/** Окна задаются по дню начала; переход через полночь относится к следующему дню. */
function inWindow(windows,day,minute,duration=0){return windows.some(window=>{const start=minutes(window.start);const end=minutes(window.end);const length=(end-start+1440)%1440||1440;let offset=minute-start;let startDay=day;if(offset<0){offset+=1440;startDay=day===1?7:day-1;}return window.days.includes(startDay)&&offset<length&&offset+duration<=length;});}
/** Строгий контракт не позволяет сохранить расписание вне допустимых окон. */
function validateMaintenancePolicy(value){
    keys(value,Object.keys(defaultPolicy));
    if(Object.keys(defaultPolicy).some(key=>value[key]===undefined)||typeof value.enabled!=='boolean'||typeof value.timeZone!=='string'||value.timeZone.length>100){throw new Error('Заполните все настройки обслуживания');}
    try{new Intl.DateTimeFormat('en',{timeZone:value.timeZone}).format();}catch{throw new Error('Укажите существующий часовой пояс IANA');}
    keys(value.schedule,['days','time']);const schedule={days:days(value.schedule.days),time:value.schedule.time};
    if(typeof schedule.time!=='string'||!timePattern.test(schedule.time)){throw new Error('Время копирования: ЧЧ:ММ');}
    if(!Array.isArray(value.windows)||!value.windows.length||value.windows.length>7){throw new Error('Укажите от одного до семи окон обслуживания');}
    const windows=value.windows.map(window=>{keys(window,['days','start','end']);if(![window.start,window.end].every(time=>typeof time==='string'&&timePattern.test(time))){throw new Error('Границы окна: ЧЧ:ММ');}return {days:days(window.days),start:window.start,end:window.end};});
    for(const [key,min,max] of [['maxPauseMinutes',2,1440],['localCopies',1,100],['externalRetentionDays',1,3650],['rpoMinutes',1,10080],['rtoMinutes',1,10080]]){if(!Number.isSafeInteger(value[key])||value[key]<min||value[key]>max){throw new Error(key+': целое число от '+min+' до '+max);}}
    if(schedule.days.some(day=>!inWindow(windows,day,minutes(schedule.time),value.maxPauseMinutes))){throw new Error('Копирование и максимальная пауза должны помещаться в допустимое окно каждого выбранного дня');}
    return {...value,schedule,windows};
}
function clockFormatter(timeZone){return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'});}
function localClock(date,timeZone,formatter=clockFormatter(timeZone)){const parts=Object.fromEntries(formatter.formatToParts(date).map(item=>[item.type,item.value]));return {day:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(parts.weekday)+1,time:parts.hour+':'+parts.minute,date:parts.year+'-'+parts.month+'-'+parts.day};}
/** Проверяет реальное существование локального слота; сдвиг вперёд не становится catch-up. */
function scheduledSlotExists(policy,local,now,formatter){
    const nominal=Date.parse(local.date+'T'+policy.schedule.time+':00Z');
    for(const delta of [-36*3600000,0,36*3600000]){
        const probe=nominal+delta,clock=localClock(probe,policy.timeZone,formatter);
        const offset=Date.parse(clock.date+'T'+clock.time+':00Z')-probe;
        const instant=nominal-offset,candidate=localClock(instant,policy.timeZone,formatter);
        if(instant<=new Date(now).getTime()&&candidate.date===local.date&&candidate.time===policy.schedule.time){return true;}
    }
    return false;
}
/** Каждый реальный момент паузы остаётся внутри одного окна, включая переход DST и секунды тика. */
function actualPauseFits(policy,now,formatter){
    const start=new Date(now).getTime(),duration=policy.maxPauseMinutes*60000;
    return policy.windows.some(window=>{
        const allowed=instant=>{const local=localClock(instant,policy.timeZone,formatter);return inWindow([window],local.day,minutes(local.time));};
        for(let elapsed=0;elapsed<duration;elapsed+=60000){if(!allowed(start+elapsed)){return false;}}
        return allowed(start+duration-1);
    });
}
/** UTC-поиск учитывает DST: отсутствующий час пропускается, повторный локальный слот не дублируется. */
function nextMaintenanceRun(policy,after=new Date(),excludedSlot){if(!policy.enabled){return null;}const formatter=clockFormatter(policy.timeZone);let instant=Math.floor(new Date(after).getTime()/60000)*60000+60000;for(let count=0;count<8*1440;count++,instant+=60000){const local=localClock(instant,policy.timeZone,formatter);const slot=local.date+'T'+local.time+'@'+policy.timeZone;if(local.time===policy.schedule.time&&policy.schedule.days.includes(local.day)&&slot!==excludedSlot&&actualPauseFits(policy,instant,formatter)){return {at:new Date(instant).toISOString(),slot};}}return null;}
/** Догоняем существовавший запуск только в его локальный день и при полном реальном окне. */
function dueMaintenanceRun(policy,now=new Date()) {if(!policy.enabled){return null;}const formatter=clockFormatter(policy.timeZone),local=localClock(now,policy.timeZone,formatter);if(!policy.schedule.days.includes(local.day)||local.time<policy.schedule.time||!scheduledSlotExists(policy,local,now,formatter)||!actualPauseFits(policy,now,formatter)){return null;}return {slot:local.date+'T'+policy.schedule.time+'@'+policy.timeZone,at:new Date(now).toISOString()};}
module.exports={defaultPolicy,validateMaintenancePolicy,nextMaintenanceRun,dueMaintenanceRun,inWindow};
