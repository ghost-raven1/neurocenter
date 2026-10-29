import {useLayoutEffect,useMemo,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {baseApi} from '../../core/api';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {durableJournalOwner} from '../UserBlock/durableJournalOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import type {ICatalogModel} from '../ModelCatalog/types';
import {ggufImportApi} from './api';
import {createGgufImportController,initialGgufImport,type GgufImportState} from './controller';
import {ggufJournal} from './journal';

/** Durable principal identity keeps receipts; full auth scope fences requests, File and callbacks. */
export function useGgufImport(onImported:(model:ICatalogModel)=>void|Promise<void>){
    const {scope,captureOwner}=useAuthRequestOwner(),user=useSelector((state:RootState)=>state.userBlock.user);
    const availability=useFeatureAvailability('gguf_import','model_hosting','model_catalog');
    const canWrite=user?.activeRole==='Главный админ';
    const principal=durableJournalOwner(user,baseApi.defaults.baseURL||window.location.origin),ownerKey=JSON.stringify([scope,principal]);
    const access=useRef({canWrite,enabled:availability.enabled}),owner=useRef(ownerKey),callback=useRef(onImported);
    access.current={canWrite,enabled:availability.enabled};owner.current=ownerKey;callback.current=onImported;
    const [value,setValue]=useState<{ownerKey:string;state:GgufImportState}>({ownerKey:'',state:initialGgufImport()});
    const controller=useMemo(()=>createGgufImportController({api:ggufImportApi,
        journal:ggufJournal({getItem:key=>localStorage.getItem(key),setItem:(key,raw)=>localStorage.setItem(key,raw),removeItem:key=>localStorage.removeItem(key)},principal),
        uuid:()=>crypto.randomUUID(),canWrite:()=>access.current.canWrite,enabled:()=>access.current.enabled,
        captureOwner:()=>{const owns=captureOwner();return()=>owns()&&owner.current===ownerKey;},
        onChange:state=>setValue({ownerKey,state}),onImported:model=>callback.current(model),
    }),[ownerKey,principal,captureOwner]);
    useLayoutEffect(()=>{controller.activate();return controller.dispose;},[controller]);
    return {...(value.ownerKey===ownerKey?value.state:initialGgufImport()),...controller,availability,canWrite};
}
