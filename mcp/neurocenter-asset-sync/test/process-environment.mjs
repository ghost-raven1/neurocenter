import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Establish the inherited process baseline before Vitest can capture env values for unstubAllEnvs. */
export function isolateBridgeTestProcess(){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nc-bridge-tests-')));
    const home=path.join(root,'home');
    const environment={
        NEUROCENTER_TEST_PROCESS_ROOT:root,
        HOME:home,USERPROFILE:home,
        CODEX_HOME:path.join(home,'.codex'),
        NEUROCENTER_BRIDGE_HOME:path.join(root,'bridge'),
        NEUROCENTER_URL:'https://bridge-tests.invalid',NEUROCENTER_API_URL:'',
        XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local','share'),XDG_CACHE_HOME:path.join(home,'.cache'),
        APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),
        OPENCODE_CONFIG:'',OPENCODE_CONFIG_DIR:'',OPENCODE_CONFIG_CONTENT:'',OPENCODE_DISABLE_PROJECT_CONFIG:'',
    };
    fs.mkdirSync(home,{recursive:true,mode:0o700});
    fs.mkdirSync(environment.NEUROCENTER_BRIDGE_HOME,{mode:0o700});
    Object.assign(process.env,environment);
    // Never restore the inherited user profile: a timed-out task can still finish during teardown.
    process.once('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
    return {root,environment};
}
