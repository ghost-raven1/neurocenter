import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'node:test';

test('Every shell bootstrap download explicitly skips certificate validation',async()=>{
    for(const file of ['connect.sh','install.sh','install_opencode.sh','install_workspace.sh']){
        const source=await fs.readFile(new URL('../../bridge-dist/'+file,import.meta.url),'utf8');
        const downloads=[...source.matchAll(/^\s*curl ([^\n]+)/gm)];assert(downloads.length>0,file);
        for(const [,command]of downloads)assert.match(command,/--insecure\b/,file);
        assert.doesNotMatch(source,/Проверка TLS остаётся включённой/,file);
    }
});

test('PowerShell bootstrap uses a request switch or restores the exact prior callback before returning (source contract)',async()=>{
    for(const file of ['connect.ps1','install.ps1','install_opencode.ps1','install_workspace.ps1']){
        const source=await fs.readFile(new URL('../../bridge-dist/'+file,import.meta.url),'utf8');
        assert.match(source,/\$PSVersionTable\.PSVersion\.Major -ge 7/,file);
        assert.match(source,/Invoke-WebRequest[^\n]*-SkipCertificateCheck/,file);
        assert.match(source,/\$PreviousCallback = \[Net\.ServicePointManager\]::ServerCertificateValidationCallback/,file);
        assert.match(source,/ServerCertificateValidationCallback = \[NeurocenterBootstrapTls\]::Accept/,file);
        assert.match(source,/finally\s*\{\s*\[Net\.ServicePointManager\]::ServerCertificateValidationCallback = \$PreviousCallback\s*\}/,file);
        assert.match(source,/RemoteCertificateValidationCallback Accept = delegate \{ return true; \}/,file);
        assert.doesNotMatch(source,/CertificatePolicy|Set-ExecutionPolicy|Проверка TLS остаётся включённой/,file);
    }
});
