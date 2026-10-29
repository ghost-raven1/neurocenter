import {isDeepStrictEqual} from 'node:util';
import {validateAsset} from './asset.mjs';
import {nativePins} from './dependencies.mjs';

/** Export an already built native tool without keeping a second runtime-artifact list in its card. */
export function createToolAsset({id,version,source,license,publication,artifacts,dependencies,resolvedDependencies,recipe}) {
  const card=structuredClone(publication),delivery=structuredClone(artifacts);
  if(Object.hasOwn(card,'publicationKey'))delete card.publicationKey;
  if(card.dependencies!==undefined&&!Array.isArray(card.dependencies))throw new Error('Invalid built native dependencies');
  if(card.dependencies?.length) {
    if(!dependencies?.length||!resolvedDependencies)throw new Error('Native dependencies require portable source mapping context');
    const resolved=nativePins({dependencies},resolvedDependencies);
    const normalizePins=pins=>pins.map(pin=>Object.fromEntries(Object.entries(pin).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
    if(!isDeepStrictEqual(normalizePins(card.dependencies),normalizePins(resolved)))throw new Error('Built native dependencies differ from portable mapping context');
  }
  delete card.dependencies;
  const declared=card.config?.extra?.runtimeArtifacts||[];
  const normalize=items=>items.map(item=>Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>a.target.localeCompare(b.target));
  if(!isDeepStrictEqual(normalize(declared),normalize(delivery.map(item=>item.descriptor))))throw new Error('Built publication and delivery runtime artifacts differ');
  if(card.config?.extra) {
    delete card.config.extra.runtimeArtifacts;
    if(!Object.keys(card.config.extra).length)delete card.config.extra;
  }
  return validateAsset({schemaVersion:1,id,kind:card.kind,version,source,license,compatibility:{packageFormat:5},card,
    delivery:{type:'runtime-artifacts',artifacts:delivery},...(dependencies?{dependencies}:{}),...(recipe?{recipe}:{})});
}
