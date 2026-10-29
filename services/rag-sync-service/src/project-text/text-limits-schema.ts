import {PROJECT_TEXT_OBJECTS} from './text-schema';

/** Explicit physical successor of text1. The original SQL, receipt bytes and semantic objects remain unchanged. */
export const PROJECT_TEXT_LIMITS_SCHEMA=`
ALTER TABLE public.project_text_documents DROP CONSTRAINT project_text_documents_path_check;
ALTER TABLE public.project_text_documents ADD CONSTRAINT project_text_documents_path_check CHECK(octet_length(path) BETWEEN 1 AND 2048);
`;
export const PROJECT_TEXT_LIMITS_OBJECTS=PROJECT_TEXT_OBJECTS;
