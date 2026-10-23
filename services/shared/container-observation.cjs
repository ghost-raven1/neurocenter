'use strict';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const project=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value);
/** Authenticated host observations contain only safe state from one operator-pinned Compose project. */
function containerObservation(value){
 if(!exact(value,['schema','project','checkedAt','available',...(value?.available===true?['items']:['reason'])])||value.schema!==1||!project(value.project)
  ||typeof value.checkedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.checkedAt)||!Number.isFinite(Date.parse(value.checkedAt)))throw Error('INVALID_CONTAINER_OBSERVATION');
 if(value.available===false){if(!['docker-unavailable','observation-limit'].includes(value.reason))throw Error('INVALID_CONTAINER_OBSERVATION');}
 else if(value.available!==true||!Array.isArray(value.items)||value.items.length>64||value.items.some(item=>!exact(item,['service','state','health'])
  ||typeof item.service!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.service)
  ||!['created','restarting','running','removing','paused','exited','dead'].includes(item.state)||!['healthy','unhealthy','starting','not-reported'].includes(item.health)))throw Error('INVALID_CONTAINER_OBSERVATION');
 if(Buffer.byteLength(JSON.stringify(value))>16384)throw Error('INVALID_CONTAINER_OBSERVATION');
 return value;
}
module.exports={containerObservation,validComposeProject:project};
