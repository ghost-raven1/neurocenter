import type {ICatalogModel,IModelCatalog} from '../ModelCatalog/types';
const digest=(value:unknown):boolean=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Embedding jobs need a project assignment, exact verified pin and the owner's supported vector dimension. */
export function publicChatEmbeddingModels(catalog:IModelCatalog):ICatalogModel[]{return catalog.items.filter(model=>catalog.assignedModelIds.includes(model.id)&&!model.archivedAt&&model.capability==='embedding'&&Number.isInteger(model.dimension)&&Number(model.dimension)>=1&&Number(model.dimension)<=16000&&digest(model.modelPin)&&(model.runtime==='ollama'?digest(model.manifestSha256):['remote-openai','remote-ollama'].includes(model.runtime)&&!!model.modelVersion&&digest(model.verificationSha256)));}
