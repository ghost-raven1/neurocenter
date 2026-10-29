import {normalizeTextSearch, normalizeTextUpload, textUploadCanonical, TEXT_KNOWLEDGE_CEILINGS} from '@neurocenter/project-text-knowledge';
import {errorMessage} from '../../common/utils/errorMessage';
import type {ProjectTextApi} from './api';
import {readTextFiles} from './files';
import type {TextJournal, TextUploadIntent} from './journal';
import type {TextCorpusState, TextDocument, TextSearchResult, TextUpload, TextUploadReceipt} from './model';
import {type TextKnowledgeLimits, type TextLimitsDecision} from './limits';

export interface TextKnowledgeState {
    corpus?:TextCorpusState; documents:TextDocument[]; query:string; result?:TextSearchResult;
    intent?:TextUploadIntent; receipt?:TextUploadReceipt;
    reading:boolean; selecting:boolean; uploading:boolean; recovering:boolean; searching:boolean;
    readError:string; uploadError:string; searchError:string; journalError:string; recoveryMessage:string; canRebase:boolean;
    limits?:TextLimitsDecision; limitsError:string; loadingLimits:boolean;
}
export const initialTextKnowledge = ():TextKnowledgeState => ({documents:[], query:'', reading:false, selecting:false,
    uploading:false, recovering:false, searching:false, readError:'', uploadError:'', searchError:'', journalError:'', recoveryMessage:'', canRebase:false,
    limitsError:'', loadingLimits:false});
interface Options {
    projectId:string; email:string; api:ProjectTextApi; journal:TextJournal;
    hash:(canonical:string) => Promise<string>; uuid:() => string;
    captureOwner:() => () => boolean; enabled:() => boolean; canWrite:() => boolean;
    onChange:(state:TextKnowledgeState) => void;
    limits?:Readonly<TextKnowledgeLimits>;
}
const status = (error:unknown):number|undefined => (error as {response?:{status?:number}} | null)?.response?.status;

/** Owns one explicit file intent; unknown acknowledgements never generate a replacement key. */
export function createTextKnowledgeController(options:Options) {
    let state = initialTextKnowledge(), active = false, epoch = 0, reads = 0, selections = 0, searches = 0, policyReads = 0;
    const transports = new Set<AbortController>();
    let searchTransport:AbortController | undefined;
    let journalKey:string | undefined;
    const emit = (change:Partial<TextKnowledgeState>) => {state = {...state, ...change}; options.onChange(state);};
    const owned = () => {const at = epoch, owner = options.captureOwner(); return () => active && epoch === at && owner();};
    const transport = () => {const controller = new AbortController(); transports.add(controller); return controller;};
    const invalidateSearch = () => {searches++; searchTransport?.abort(); emit({result:undefined, searching:false, searchError:''});};
    const refreshLimits = async ():Promise<TextLimitsDecision | undefined> => {
        const owns = owned(), sequence = ++policyReads;
        if (!owns()) return;
        const abort = transport(); emit({loadingLimits:true});
        try {
            const decision = options.limits ? {revision:0,limits:options.limits} : await options.api.limits(abort.signal);
            if (!owns() || sequence !== policyReads) return;
            emit({limits:decision, limitsError:''}); return decision;
        } catch (error) {if (owns() && sequence === policyReads) emit({limitsError:errorMessage(error,'Не удалось получить лимиты базы знаний. Ввод сохранён; повторите проверку.')});}
        finally {transports.delete(abort); if (owns() && sequence === policyReads) emit({loadingLimits:false});}
    };
    const applyCorpus = (value:TextCorpusState) => {
        if (state.corpus && value.revision < state.corpus.revision) return;
        if (state.corpus && value.revision === state.corpus.revision && value.corpusHash !== state.corpus.corpusHash) throw Error('Состояние базы знаний противоречиво. Обновите сведения.');
        if (state.corpus?.corpusHash !== value.corpusHash || state.corpus.revision !== value.revision) invalidateSearch();
        emit({corpus:value});
    };
    const refresh = async () => {
        const owns = owned(), sequence = ++reads;
        if (!owns()) return;
        const abort = transport();
        emit({reading:true});
        try {
            const corpus = await options.api.state(options.projectId, abort.signal);
            if (owns() && sequence === reads) {applyCorpus(corpus); emit({readError:''});}
        } catch (error) {
            if (owns() && sequence === reads) {
                if ([401,403,404].includes(status(error) ?? 0)) {invalidateSearch(); emit({corpus:undefined, receipt:undefined});}
                emit({readError:errorMessage(error, 'Не удалось загрузить сведения о базе знаний.')});
            }
        } finally {transports.delete(abort); if (owns() && sequence === reads) emit({reading:false});}
    };
    const accept = (receipt:TextUploadReceipt, intent:TextUploadIntent) => {
        if (receipt.projectId !== options.projectId || receipt.requestKey !== intent.requestKey || receipt.requestHash !== intent.requestHash
            || receipt.revision !== intent.expectedRevision + 1) throw Error('Квитанция относится к другой загрузке. Прежний ключ сохранён.');
        // A historical receipt proves its upload, never the currently authoritative corpus.
        emit({receipt, documents:[], uploadError:'', recoveryMessage:'Загрузка подтверждена сервером.', canRebase:false});
    };
    const recover = async (conflict = false) => {
        const intent = state.intent, owns = owned(), abort = transport();
        if (!owns() || !intent || state.recovering) {transports.delete(abort); return;}
        emit({recovering:true, recoveryMessage:''});
        try {
            const receipt = await options.api.receipt(options.projectId, intent.requestKey, abort.signal);
            if (!owns() || state.intent?.requestKey !== intent.requestKey) return;
            if (receipt) {accept(receipt, intent); await refresh();}
            else emit({recoveryMessage:'Квитанция пока не найдена. Для повтора выберите те же файлы в том же порядке; ключ загрузки сохранён.', canRebase:conflict});
        } catch (error) {
            if (owns()) emit({recoveryMessage:errorMessage(error, 'Не удалось проверить прежнюю загрузку. Ключ сохранён.')});
        } finally {transports.delete(abort); if (owns()) emit({recovering:false});}
    };
    const selectFiles = async (files:Parameters<typeof readTextFiles>[0]) => {
        const owns = owned(), sequence = ++selections;
        if (!owns() || state.uploading || state.recovering) return;
        emit({selecting:true, uploadError:''});
        try {
            const policy = state.intent && !state.receipt ? TEXT_KNOWLEDGE_CEILINGS : state.limits?.limits;
            if (!policy || state.limitsError && !state.intent) throw Error('Сначала подтвердите лимиты базы знаний.');
            const documents = await readTextFiles(files, policy); if (owns() && sequence === selections) emit({documents});
        }
        catch (error) {if (owns() && sequence === selections) emit({uploadError:errorMessage(error, 'Не удалось прочитать файлы.')});}
        finally {if (owns() && sequence === selections) emit({selecting:false});}
    };
    const upload = async () => {
        const owns = owned();
        if (!owns() || !options.enabled() || !options.canWrite() || state.uploading || state.selecting || state.recovering || state.journalError || !state.corpus) return;
        emit({uploading:true, uploadError:'', canRebase:false});
        let abort:AbortController | undefined;
        try {
            const previous = state.intent && !state.receipt ? state.intent : undefined;
            const decision = previous ? undefined : await refreshLimits();
            if (!owns() || !previous && !decision) return;
            const body:TextUpload = normalizeTextUpload({requestKey:previous?.requestKey ?? options.uuid(),
                expectedRevision:previous?.expectedRevision ?? state.corpus!.revision, documents:state.documents}, previous ? TEXT_KNOWLEDGE_CEILINGS : decision!.limits);
            const requestHash = await options.hash(textUploadCanonical(body));
            if (!owns() || !options.enabled() || !options.canWrite()) return;
            if (previous && previous.requestHash !== requestHash) throw Error('Для повтора нужны исходные файлы с теми же именами, содержимым и порядком. Прежний ключ сохранён.');
            const intent:TextUploadIntent = previous ?? {version:1, projectId:options.projectId, email:options.email,
                requestKey:body.requestKey, expectedRevision:body.expectedRevision, requestHash};
            if (!previous) {
                try { options.journal.write(intent, journalKey); journalKey = intent.requestKey; }
                catch { throw Error('Не удалось сохранить ключ повтора. Загрузка не отправлена; проверьте доступность хранилища браузера.'); }
            }
            emit({intent, receipt:undefined, recoveryMessage:''});
            abort = transport();
            try {
                const receipt = await options.api.upload(options.projectId, body, abort.signal);
                if (owns()) {accept(receipt, intent); await refresh();}
            } catch (error) {
                if (!owns()) return;
                emit({uploadError:errorMessage(error, 'Ответ загрузки не получен. Проверяем квитанцию с прежним ключом.')});
                await recover(status(error) === 409);
                if (status(error) === 409 && owns()) await refresh();
            }
        } catch (error) {if (owns()) emit({uploadError:errorMessage(error, 'Не удалось подготовить загрузку.')});}
        finally {if (abort) transports.delete(abort); if (owns()) emit({uploading:false});}
    };
    const search = async () => {
        const owns = owned(), corpus = state.corpus, query = state.query;
        if (!owns() || !options.enabled() || !corpus) return;
        invalidateSearch(); const sequence = searches, abort = transport(); searchTransport = abort;
        emit({searching:true});
        try {
            const decision = await refreshLimits();
            if (!owns() || sequence !== searches || !decision || !options.enabled()) return;
            normalizeTextSearch({query, revision:corpus.revision}, decision.limits);
            const result = await options.api.search(options.projectId, query, corpus.revision, abort.signal);
            if (!owns() || sequence !== searches || !options.enabled()) return;
            if (result.projectId !== options.projectId || result.revision !== corpus.revision || result.corpusHash !== corpus.corpusHash
                || state.corpus?.revision !== corpus.revision || state.corpus.corpusHash !== corpus.corpusHash) throw Error('База знаний изменилась. Повторите поиск по актуальной версии.');
            emit({result, searchError:''});
        } catch (error) {
            if (owns() && sequence === searches) {
                emit({searchError:errorMessage(error, 'Не удалось выполнить поиск. Запрос сохранён.')});
                if (status(error) === 409) await refresh();
            }
        } finally {transports.delete(abort); if (owns() && sequence === searches) emit({searching:false});}
    };
    return {
        activate:() => {
            active = true; epoch++; state = initialTextKnowledge();
            try {const intent = options.journal.read() ?? undefined; journalKey = intent?.requestKey; emit({intent});}
            catch (error) {emit({journalError:errorMessage(error, 'Журнал загрузки недоступен. Новая загрузка приостановлена.')});}
            void refresh(); void refreshLimits(); if (state.intent) void recover();
        },
        dispose:() => {active = false; epoch++; transports.forEach(controller => controller.abort()); transports.clear();},
        refresh, refreshLimits, recover:() => recover(), selectFiles, upload, search, invalidateSearch,
        setQuery:(query:string) => {invalidateSearch(); emit({query});},
        removeFile:(path:string) => {if (!state.uploading && !state.recovering) emit({documents:state.documents.filter(document => document.path !== path)});},
        rebase:() => {
            if (!state.canRebase || !options.enabled() || !options.canWrite() || state.uploading || state.recovering) return;
            // Only an explicit 409 plus a missing receipt permits a new intent; files remain untouched.
            emit({intent:undefined, receipt:undefined, canRebase:false, recoveryMessage:'Новая загрузка будет использовать актуальную ревизию.', uploadError:''});
        },
    };
}
