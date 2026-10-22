import {describe,expect,it} from 'vitest';
import {bridgeArchiveRequest,bridgeArchiveTargets,localBridgeArchiveCommand,readBridgeArchive} from '../src/features/McpBridge/bridgeArchive';
const supply={version:'0.9.18',buildId:'b'.repeat(64),targets:['darwin-arm64','linux-x64-musl','windows-x64']};
const request=bridgeArchiveRequest('https://gateway.test:8443',supply,'linux-x64-musl');
const metadata={version:supply.version,buildId:supply.buildId,target:'linux-x64-musl',sha256:'c'.repeat(64),bytes:12345};
describe('Точный архив моста и локальная команда',()=>{
    it('Путь строится по выбранной полной платформе и Gateway, а возвращённые поля копируются по allowlist',()=>{
        expect(request).toEqual({origin:'https://gateway.test:8443',version:'0.9.18',buildId:'b'.repeat(64),target:'linux-x64-musl',file:'neurocenter-asset-sync-linux-x64-musl-0.9.18.tgz'});
        expect(readBridgeArchive({...metadata,externalUrl:'https://foreign.test',secret:'ignored'},request)).toEqual({...request,sha256:metadata.sha256,bytes:12345});
    });
    it.each([{version:'0.9.19'},{buildId:'a'.repeat(64)},{target:'linux-x64'},{sha256:'g'.repeat(64)},{sha256:123},{bytes:0},{bytes:1.5},{bytes:1024**3+1},{bytes:'12345'}])('Несовпадение или повреждение metadata не создаёт download descriptor: %j',override=>{
        expect(()=>readBridgeArchive({...metadata,...override},request)).toThrow('Метаданные архива');
    });
    it.each([{value:null},{value:[]},{value:undefined}])('Отсутствующая metadata отклоняется: %j',({value})=>{expect(()=>readBridgeArchive(value,request)).toThrow();});
    it.each([{...supply,version:'0.9.18-beta'},{...supply,buildId:'wrong'},{...supply,targets:['linux-x64','linux-x64']},{...supply,targets:['darwin-arm64-musl']},{...supply,targets:[]}])('Не предлагает некорректную поставку: %j',value=>{expect(bridgeArchiveTargets(value)).toEqual([]);});
    it.each(['https://gateway.test/path','https://user:secret@gateway.test','file:///tmp/bridge','https://gateway.test?token=secret'])('Не создаёт download URL из непроверенного origin %s',origin=>{expect(()=>bridgeArchiveRequest(origin,supply,'linux-x64-musl')).toThrow();});
    it('Отсутствующий target не заменяется похожей платформой или libc',()=>{expect(()=>bridgeArchiveRequest('https://gateway.test',supply,'linux-x64')).toThrow();expect(bridgeArchiveTargets(undefined)).toEqual([]);});
    it('Bash получает один буквальный local path, включая пробелы, апостроф и shell substitutions',()=>{
        expect(localBridgeArchiveCommand("./team's $(printf bad) bridge.tgz",false)).toBe("bash ./install.sh --archive './team'\"'\"'s $(printf bad) bridge.tgz'");
    });
    it('PowerShell получает один буквальный path без сетевого вызова или нового Node',()=>{
        expect(localBridgeArchiveCommand("C:\\My Files\\team's bridge.tgz",true)).toBe("& .\\install.ps1 -Archive 'C:\\My Files\\team''s bridge.tgz'");
    });
    it.each(['',' ','file\nname.tgz','file\rname.tgz','file\x00name.tgz','x'.repeat(4097)])('Не формирует команду из пустого или управляющего пути',value=>{expect(()=>localBridgeArchiveCommand(value,false)).toThrow('локальному архиву');});
});
