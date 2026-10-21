'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {pathToFileURL}=require('node:url');
const {TextDecoder}=require('node:util');
const {crc32}=require('node:zlib');
const fail=message=>{const error=new Error(message);error.userMessage=message;throw error;};
const bytes=Buffer.from(workerData.bytes);
const bounded=text=>{
    text=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
    if(!text.trim())fail('В файле нет извлекаемого текста. Для сканов потребуется OCR с vision-моделью.');
    if(Buffer.byteLength(text)>workerData.maxTextBytes)fail('В документе больше 100 КиБ текста. Разделите его на части: содержимое не было обрезано.');
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))fail('Файл содержит двоичные данные или неподдерживаемые управляющие символы.');
    return text;
};

/** Validate all ZIP entries before Mammoth allocates decompressed XML or follows document relationships. */
async function checkDocx(){
    const yauzl=require(workerData.yauzlModule),zip=await yauzl.fromBufferPromise(bytes,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true});
    const names=new Set();let count=0,total=0;
    try{
        await new Promise((resolve,reject)=>{
            let stopped=false;
            const done=error=>{if(stopped)return;stopped=true;zip.close();error?reject(error):resolve();};
            zip.on('error',done);zip.on('end',()=>done());
            zip.on('entry',entry=>{void(async()=>{
                if(++count>1000)fail('DOCX содержит слишком много внутренних файлов.');
                const name=entry.fileName,mode=(entry.externalFileAttributes>>>16)&0o170000;
                if(names.has(name)||name.includes('\\')||name.startsWith('/')||name.split('/').includes('..')||entry.generalPurposeBitFlag&1||mode&&mode!==0o100000&&mode!==0o040000)fail('DOCX содержит повторяющиеся, зашифрованные или небезопасные записи.');
                const local=await zip.readLocalFileHeaderPromise(entry);
                if(!local.fileName.equals(entry.fileNameRaw)||local.generalPurposeBitFlag!==entry.generalPurposeBitFlag||local.compressionMethod!==entry.compressionMethod)fail('DOCX повреждён: заголовки внутренних файлов не совпадают.');
                if(name.endsWith('/')&&entry.uncompressedSize!==0)fail('DOCX содержит папку с данными вместо файла.');
                names.add(name);total+=entry.uncompressedSize;
                if(entry.uncompressedSize>8*1024*1024||total>24*1024*1024)fail('Распакованный DOCX слишком большой.');
                {
                    const stream=await zip.openReadStreamPromise(entry);let size=0,crc=0;
                    try{for await(const chunk of stream){size+=chunk.length;if(size>entry.uncompressedSize||size>8*1024*1024)fail('DOCX превышает объявленный размер.');crc=crc32(chunk,crc);}}
                    finally{stream.destroy();}
                    if(size!==entry.uncompressedSize||crc!==entry.crc32)fail('DOCX повреждён: контрольная сумма не совпадает.');
                }
                if(!stopped)zip.readEntry();
            })().catch(done);});zip.readEntry();
        });
    }finally{zip.close();}
    if(!names.has('[Content_Types].xml')||!names.has('word/document.xml'))fail('Это не документ DOCX.');
}

async function extract(){
    if(workerData.kind==='text'){
        let encoding='utf-8';
        if(bytes[0]===255&&bytes[1]===254)encoding='utf-16le';
        else if(bytes[0]===254&&bytes[1]===255)encoding='utf-16be';
        let text;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{fail('Не удалось прочитать кодировку. Сохраните текст в UTF-8 или UTF-16 с BOM.');}
        return {mediaType:'text/plain',text:bounded(text)};
    }
    if(workerData.kind==='docx'){
        if(bytes.readUInt32LE(0)!==0x04034b50)fail('Содержимое файла не соответствует формату DOCX.');
        await checkDocx();
        const result=await require(workerData.mammothModule).extractRawText({buffer:bytes});
        return {mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',text:bounded(result.value),
            warning:'Извлечён текст документа; изображения и оформление не передаются модели.'};
    }
    if(bytes.subarray(0,5).toString()!=='%PDF-')fail('Содержимое файла не соответствует формату PDF.');
    const pdfjs=await import(pathToFileURL(workerData.pdfModule).href);
    const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:false,
        useWorkerFetch:false,isOffscreenCanvasSupported:false,enableXfa:false,stopAtErrors:true,maxImageSize:1,verbosity:0});
    try{
        const pdf=await task.promise;if(pdf.numPages>100)fail('В PDF больше 100 страниц. Разделите документ на части.');
        const pages=[];let size=0,emptyPages=0;
        for(let number=1;number<=pdf.numPages;number++){
            const page=await pdf.getPage(number),reader=page.streamTextContent().getReader();let text='';
            try{for(;;){const {done,value}=await reader.read();if(done)break;for(const item of value.items){if(typeof item.str!=='string')continue;const part=item.str+(item.hasEOL?'\n':' ');size+=Buffer.byteLength(part);if(size>workerData.maxTextBytes)fail('В документе больше 100 КиБ текста. Разделите его на части: содержимое не было обрезано.');text+=part;}}}
            finally{await reader.cancel().catch(()=>{});page.cleanup();}
            if(!text.trim())emptyPages++;
            pages.push(`[Страница ${number}]\n${text.trim()||'[Текст не извлечён]'}`);
        }
        if(emptyPages===pdf.numPages)fail('В PDF нет текстового слоя. Распознавание сканов будет доступно после подключения vision-модели.');
        return {mediaType:'application/pdf',text:bounded(pages.join('\n\n')),pages:pdf.numPages,
            warning:emptyPages?`На ${emptyPages} из ${pdf.numPages} страниц текст не извлечён. OCR и изображения не передаются модели.`:'Извлечён текст PDF по страницам; изображения и оформление не передаются модели.'};
    }catch(error){if(error.name==='PasswordException')fail('PDF защищён паролем. Загрузите незашифрованную копию.');throw error;}
    finally{await task.destroy();}
}
extract().then(value=>parentPort.postMessage({ok:true,value})).catch(error=>parentPort.postMessage({ok:false,error:error.userMessage||'Документ повреждён или его текст не удалось извлечь.'}));
