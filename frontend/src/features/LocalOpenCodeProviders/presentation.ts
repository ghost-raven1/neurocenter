import type {GlobalProvider} from '@neurocenter/opencode-local-providers';

/** Presence labels describe observed files and never claim a successful provider response. */
export function providerAuthenticationLabel(authentication:GlobalProvider['authentication'],legacy:boolean):string{
    if(authentication==='oauth')return legacy?'OAuth в прежнем файле':'OAuth сохранён';
    if(authentication==='api')return legacy?'API-ключ в прежнем файле':'API-ключ настроен';
    if(authentication==='none')return 'Без сохранённого ключа';
    if(authentication==='reference')return 'Ключ из локальной ссылки';
    return 'Авторизация требует проверки';
}
