import {readFile} from 'node:fs/promises';

/** Expand the exact shared sources used by public templates in isolated script checks. */
export async function readBridgeTemplate(file) {
    let source=await readFile(file,'utf8');
    for(const [token,name]of [['__BRIDGE_CONTEXT__','context.cjs'],['__BRIDGE_CONNECT__','connect.cjs']]) {
        if(!source.includes(token))continue;
        if(source.split(token).length!==2)throw Error('Ambiguous bridge template slot: '+token);
        const content=await readFile(new URL('../../bridge-dist/'+name,import.meta.url),'utf8');
        source=source.replace(token,()=>content);
    }
    return source;
}
