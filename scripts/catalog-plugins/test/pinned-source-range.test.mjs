import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {prepareAdditionalSource} from '../source-adapters.mjs';

test('Repository-equivalent pinned psinetron >= dependency reaches immutable npm ci and packaging',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-pinned-range-')),previous=process.env.NPM_CLI_JS;
    try{
        await fs.mkdir(path.join(root,'source'));
        const dependencies={'@opencode-ai/plugin':'>=1.16.0'};
        await fs.writeFile(path.join(root,'source/package.json'),JSON.stringify({name:'psinetron-opencode-visualizer',version:'1.0.17',type:'module',dependencies}));
        await fs.writeFile(path.join(root,'source/index.ts'),'import type {Plugin} from "@opencode-ai/plugin"; export default async()=>({event:async()=>{}});');
        await fs.writeFile(path.join(root,'source/package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies},'node_modules/@opencode-ai/plugin':{
            version:'1.18.34',resolved:'https://registry.npmjs.org/@opencode-ai/plugin/-/plugin-1.18.34.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}}));
        const npm=path.join(root,'fixture-npm.mjs');process.env.NPM_CLI_JS=npm;
        await fs.writeFile(npm,`import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
const args=process.argv.slice(2),dir=args[args.indexOf('--prefix')+1];assert.equal(args[0],'ci');assert.ok(args.includes('--ignore-scripts'));
const lock=JSON.parse(await fs.readFile(path.join(dir,'package-lock.json'),'utf8'));assert.equal(lock.packages['node_modules/@opencode-ai/plugin'].version,'1.18.34');
await fs.mkdir(path.join(dir,'node_modules'),{recursive:true});`);
        const directory=path.join(root,'output');await fs.mkdir(directory);
        const result=await prepareAdditionalSource({source:{type:'project',directory:'source',entrypoint:'index.ts'}},{recipeDirectory:root,directory,target:'darwin-arm64'});
        assert.equal(result.entrypoint,'entrypoint.mjs');assert.match(await fs.readFile(path.join(directory,result.entrypoint),'utf8'),/event/);
    }finally{if(previous===undefined)delete process.env.NPM_CLI_JS;else process.env.NPM_CLI_JS=previous;await fs.rm(root,{recursive:true,force:true});}
});
