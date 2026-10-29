import {useLayoutEffect,useMemo,useRef,useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {baseApi} from '../../core/api';
import {durableJournalOwner} from '../UserBlock/durableJournalOwner';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {personalProviderApi} from './api';
import {createPersonalAccessController,initialPersonalAccess,type PersonalAccessState} from './controller';

/** A live auth change fences drafts immediately while stable journal identity permits later receipt recovery. */
export function usePersonalProviderAccess(modelId:string){
    const {scope,captureOwner}=useAuthRequestOwner(),user=useSelector((state:RootState)=>state.userBlock.user);
    const availability=useFeatureAvailability('personal_remote_provider_credentials');
    const journalOwner=durableJournalOwner(user,baseApi.defaults.baseURL||window.location.origin);
    const ownerKey=JSON.stringify([scope,journalOwner,modelId]);
    const current=useRef(ownerKey);current.current=ownerKey;
    const enabled=useRef(availability.enabled);enabled.current=availability.enabled;
    const [value,setValue]=useState<{ownerKey:string;state:PersonalAccessState}>({ownerKey:'',state:initialPersonalAccess()});
    const controller=useMemo(()=>createPersonalAccessController({modelId,api:personalProviderApi,
        storage:{getItem:key=>localStorage.getItem(key),setItem:(key,raw)=>localStorage.setItem(key,raw),removeItem:key=>localStorage.removeItem(key)},
        journal:`neurocenter:personal-provider:v1:${journalOwner}:${modelId}`,uuid:()=>crypto.randomUUID(),
        captureOwner:()=>{const owns=captureOwner();return()=>owns()&&current.current===ownerKey;},enabled:()=>enabled.current,
        onChange:state=>setValue({ownerKey,state})}),[modelId,journalOwner,ownerKey,captureOwner]);
    useLayoutEffect(()=>{controller.activate();return controller.dispose;},[controller]);
    return{...(value.ownerKey===ownerKey?value.state:initialPersonalAccess()),...controller,availability};
}
