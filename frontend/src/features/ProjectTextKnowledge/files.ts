import {normalizeTextUpload, textBytes} from '@neurocenter/project-text-knowledge';
import type {TextDocument} from './model';
import {defaultTextKnowledgeLimits, formatKnowledgeBytes, type TextKnowledgeLimits} from './limits';

interface TextFile {name:string; size:number; webkitRelativePath?:string; arrayBuffer:() => Promise<ArrayBuffer>;}
const validationKey = '00000000-0000-0000-0000-000000000000';

/** Read strict UTF-8 in memory; a failed selection never replaces the previous draft. */
export async function readTextFiles(files:readonly TextFile[], limits:Readonly<TextKnowledgeLimits> = defaultTextKnowledgeLimits):Promise<TextDocument[]> {
    if (!files.length || files.length > limits.documents) throw Error(`Выберите от 1 до ${limits.documents} текстовых файлов.`);
    let bytes = 0;
    for (const file of files) {
        if (file.size > limits.fileBytes) throw Error(`«${file.name}»: размер файла превышает ${formatKnowledgeBytes(limits.fileBytes)}.`);
        bytes += file.size;
    }
    if (bytes > limits.batchBytes) throw Error(`Общий размер загрузки превышает ${formatKnowledgeBytes(limits.batchBytes)}.`);
    const documents:TextDocument[] = [];
    for (const file of files) {
        let content:string;
        try { content = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(await file.arrayBuffer()); }
        catch { throw Error(`«${file.name}»: нужен текстовый файл в UTF-8.`); }
        const path = file.webkitRelativePath || file.name;
        if (textBytes(path) > limits.pathBytes) throw Error(`Имя файла превышает ${limits.pathBytes} байт.`);
        documents.push({path, content});
    }
    if (documents.reduce((sum, item) => sum + textBytes(item.path) + textBytes(item.content), 0) > limits.batchBytes)
        throw Error(`Общий размер загрузки превышает ${formatKnowledgeBytes(limits.batchBytes)}.`);
    return normalizeTextUpload({requestKey:validationKey, expectedRevision:0, documents}, limits).documents;
}
