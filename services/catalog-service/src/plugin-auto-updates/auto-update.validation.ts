import {BadRequestException,ConflictException} from '@nestjs/common';
import {ROLES} from '../access/access.model';
import type {JobInput} from '../devices/device-job.model';
import type {AutoUpdateMutation,AutoUpdateRow,AutoUpdateTarget} from './auto-update.types';
export const autoUpdateUuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=500&&!/[\x00-\x1f\x7f]/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function autoUpdateTarget(raw:unknown,mutation=false):AutoUpdateTarget {
 const allowed=['deviceId','projectId','bindingId','assetId',...(mutation?['enabled','expectedRevision','requestKey']:[])];
 if(!object(raw)||Object.keys(raw).length!==allowed.length||Object.keys(raw).some(key=>!allowed.includes(key))
  ||!text(raw.deviceId)||!text(raw.projectId)||!text(raw.assetId)||typeof raw.bindingId!=='string'||!/^[a-f0-9]{64}$/.test(raw.bindingId))
  throw new BadRequestException('Выберите установленный плагин и его текущую папку.');
 return {deviceId:raw.deviceId,projectId:raw.projectId,bindingId:raw.bindingId,assetId:raw.assetId};
}
export function autoUpdateMutation(raw:unknown):AutoUpdateMutation {
 const target=autoUpdateTarget(raw,true),input=raw as Record<string,unknown>;
 if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0||!autoUpdateUuid(input.requestKey))
  throw new BadRequestException('Нужны выбранный режим, актуальная ревизия и ключ запроса.');
 return {...target,enabled:input.enabled,expectedRevision:Number(input.expectedRevision),requestKey:input.requestKey};
}
/** Restarts reuse only the persisted bounded install input for this exact policy tuple. */
export function pendingAutoUpdate(row:AutoUpdateRow):JobInput {
 const input=row.pending_input,keys=['deviceId','projectId','kind','requestKey','assetId','assetKind','version','expectedBindingId','expectedManifest','planId','planRevision'];
 if(!row.pending_role||!ROLES.some(role=>role===row.pending_role)||!input||Object.keys(input).length!==keys.length||Object.keys(input).some(key=>!keys.includes(key))
  ||input.deviceId!==row.device_id||input.projectId!==row.project_id||input.assetId!==row.asset_id||input.assetKind!=='plugin'||input.kind!=='install'
  ||input.expectedBindingId!==row.binding_id||!autoUpdateUuid(input.requestKey)||!autoUpdateUuid(input.planId)
  ||!Number.isSafeInteger(input.version)||Number(input.version)<1||!Number.isSafeInteger(input.planRevision)||Number(input.planRevision)<0
  ||typeof input.expectedManifest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedManifest))throw new ConflictException('Сохранённый запрос автообновления повреждён. Проверьте установку вручную.');
 return input;
}
