import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateOpenApi} from './document.mjs';
export {generateOpenApi} from './document.mjs';

/** Source scanning is a build step: the runtime consumes only the resulting JSON artifact. */
export function main(args){
    let root=process.env.NEUROCENTER_OPENAPI_ROOT||fileURLToPath(new URL('../../',import.meta.url)),output;
    for(let index=0;index<args.length;index++){
        const option=args[index],value=args[++index];
        if(!value||!['--root','--output'].includes(option))throw new Error('Usage: generate.mjs [--root repository] --output document.json');
        if(option==='--root')root=path.resolve(value);else output=path.resolve(value);
    }
    if(!output)throw new Error('OpenAPI output path is required.');
    const document=generateOpenApi(root);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(document,null,2)+'\n');
    console.log(`OpenAPI: ${Object.keys(document.paths).length} paths, ${Object.values(document.paths).reduce((sum,item)=>sum+Object.keys(item).length,0)} operations.`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2));
