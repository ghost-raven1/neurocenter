import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {featureFlagsMigrationManifest} from '../src/database/migrations';

/** Execute the real entrypoint without compiled dist or ambient production credentials. */
function run(...args:string[]){
    return spawnSync(process.execPath,['-r','ts-node/register/transpile-only','src/database/migrate.cli.ts',...args],{
        cwd:process.cwd(),encoding:'utf8',timeout:15000,
        env:{PATH:process.env.PATH,NODE_ENV:'production',CATALOG_PG_URL_FILE:'/missing-neurocenter-cli-secret'},
    });
}
describe('Offline migration manifest CLI',()=>{
    it('Manifest is available without production configuration or a database',()=>{
        const result=run('manifest');expect(result.error).toBeUndefined();expect(result.status).toBe(0);expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(featureFlagsMigrationManifest());
    });
    it.each([[],['unknown'],['manifest','--ready'],['check','--unknown'],['migrate','unexpected'],['check','--ready','unexpected']].map(args=>({args})))('Rejects invalid arguments before reading secrets: $args',({args})=>{
        const result=run(...args);expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toContain('Команды:');
        expect(result.stderr).not.toContain('прочитать секрет');
    });
    it('A real check requires valid configuration and does not accidentally run as a manifest',()=>{
        const result=run('check');expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toContain('прочитать секрет CATALOG_PG_URL');
    });
});
