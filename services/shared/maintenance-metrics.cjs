'use strict';
let snapshot;
/** Содержит только агрегаты обслуживания; никаких идентификаторов и секретов в метках. */
function setMaintenanceMetrics(status){snapshot={at:Date.now(),verified:status.external?1:0,age:status.externalAgeSeconds??-1,exceeded:status.rpoExceeded?1:0,next:status.nextRunAt?Date.parse(status.nextRunAt)/1000:0,failed:status.runs[0]?.state==='failed'?1:0};}
function renderMaintenanceMetrics(){const s=snapshot;return [['neurocenter_backup_status_available',s&&Date.now()-s.at<90000?1:0],['neurocenter_external_backup_verified',s?.verified??0],['neurocenter_external_backup_age_seconds',s?.age??-1],['neurocenter_backup_rpo_exceeded',s?.exceeded??1],['neurocenter_backup_next_run_timestamp_seconds',s?.next??0],['neurocenter_backup_last_run_failed',s?.failed??0]].map(([name,value])=>`# TYPE ${name} gauge\n${name} ${value}\n`).join('');}
module.exports={setMaintenanceMetrics,renderMaintenanceMetrics};
