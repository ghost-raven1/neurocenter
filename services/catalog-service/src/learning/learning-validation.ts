import {BadRequestException} from '@nestjs/common';
export function learningInput<T>(normalize:(value:unknown)=>T,raw:unknown):T{
    try{return normalize(raw);}catch{throw new BadRequestException('Проверьте обязательные поля, размеры и контракт проектного обучения.');}
}
export function learningUuid(value:unknown):asserts value is string{
    if(typeof value!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))throw new BadRequestException('Некорректный идентификатор записи обучения.');
}
