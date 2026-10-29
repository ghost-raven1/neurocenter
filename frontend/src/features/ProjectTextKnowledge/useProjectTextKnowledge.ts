import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useSelector} from 'react-redux';
import type {RootState} from '../../store';
import {baseApi} from '../../core/api';
import {useSectionUpdates} from '../../core/socket/useSectionUpdates';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {durableJournalOwner} from '../UserBlock/durableJournalOwner';
import {projectRoleLevel} from '../UserBlock/roles';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import {projectTextApi} from './api';
import {createTextKnowledgeController, initialTextKnowledge, type TextKnowledgeState} from './controller';
import {textUploadJournal, uploadHash} from './journal';
import {type TextKnowledgeLimits} from './limits';

/** Project/auth ownership fences file decoding, HTTP responses and recovery before React cleanup. */
export function useProjectTextKnowledge(projectId:string, limits?:Readonly<TextKnowledgeLimits>) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const user = useSelector((state:RootState) => state.userBlock.user);
    const availability = useFeatureAvailability('project_text_knowledge');
    const canWrite = projectRoleLevel(user, projectId) >= 2;
    const email = user?.email.trim().toLowerCase() ?? '';
    const journalOwner = durableJournalOwner(user, baseApi.defaults.baseURL || window.location.origin);
    const ownerKey = JSON.stringify([scope, projectId, journalOwner]);
    const access = useRef({enabled:availability.enabled, canWrite}); access.current = {enabled:availability.enabled, canWrite};
    const [value, setValue] = useState<{ownerKey:string; state:TextKnowledgeState}>({ownerKey:'', state:initialTextKnowledge()});
    const owner = useRef(ownerKey); owner.current = ownerKey;
    const controller = useMemo(() => createTextKnowledgeController({projectId, email, api:projectTextApi,
        journal:textUploadJournal({getItem:key => localStorage.getItem(key), setItem:(key, raw) => localStorage.setItem(key,raw)}, projectId, email, journalOwner),
        hash:uploadHash, uuid:() => crypto.randomUUID(), limits,
        enabled:() => access.current.enabled, canWrite:() => access.current.canWrite,
        captureOwner:() => {const owns = captureOwner(); return () => owns() && owner.current === ownerKey;},
        onChange:state => setValue({ownerKey, state}),
    }), [ownerKey, projectId, email, journalOwner, captureOwner, limits]);
    useLayoutEffect(() => {controller.activate(); return controller.dispose;}, [controller]);
    useSectionUpdates(['knowledge','projects','access'], () => {void controller.refresh();});
    return {...(value.ownerKey === ownerKey ? value.state : initialTextKnowledge()), ...controller, availability, canWrite};
}
