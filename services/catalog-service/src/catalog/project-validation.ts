import {BadRequestException} from '@nestjs/common';

const quotaFields=['currentBytesLimit','currentBytesUsed','retentionBytesLimit','retentionBytesUsed','stagingBytesLimit','stagingBytesUsed'];

/** Отдельный маршрут срока хранения принимает только обязательное число снимков. */
export function validateProjectRetention(value:unknown):number {
    validateProjectSettings(value);
    const input=value as Record<string,unknown>;
    if(Object.keys(input).length!==1||input.retention===undefined){
        throw new BadRequestException('Передайте только число сохраняемых снимков в поле retention.');
    }
    return input.retention as number;
}

/** Настройки проверяются до записи: счётчики и сроки не могут стать отрицательными или дробными. */
export function validateProjectSettings(value:unknown):void{
    if(!value||typeof value!=='object'||Array.isArray(value)){throw new BadRequestException('Передайте настройки проекта объектом.');}
    const input=value as Record<string,unknown>;
    if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>128||/[\x00-\x1f\x7f/\\]/.test(input.name))){throw new BadRequestException('Укажите название проекта длиной до 128 символов.');}
    if(typeof input.name==='string'&&/^prj-/i.test(input.name.trim())){throw new BadRequestException('Префикс prj- зарезервирован для идентификаторов. Выберите другое название проекта.');}
    if(input.externalResourceId!==undefined&&(typeof input.externalResourceId!=='string'||input.externalResourceId.length>512||/[\x00-\x1f]/.test(input.externalResourceId))){throw new BadRequestException('Некорректный внешний идентификатор проекта.');}
    if(input.state!==undefined&&(typeof input.state!=='string'||!['ACTIVE','ARCHIVED','LOCKED'].includes(input.state))){throw new BadRequestException('Неизвестное состояние проекта.');}
    if(input.retention!==undefined&&(!Number.isInteger(input.retention)||Number(input.retention)<1||Number(input.retention)>100)){throw new BadRequestException('Число сохраняемых снимков: целое от 1 до 100.');}
    if(input.quotas!==undefined){
        const quotas=input.quotas;
        if(!quotas||typeof quotas!=='object'||Array.isArray(quotas)||Object.entries(quotas).some(([key,number])=>!quotaFields.includes(key)||typeof number!=='number'||!Number.isSafeInteger(number)||number<0)){
            throw new BadRequestException('Квоты должны содержать неотрицательные целые значения в байтах.');
        }
    }
}
