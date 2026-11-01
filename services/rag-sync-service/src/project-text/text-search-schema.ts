import { PROJECT_TEXT_OBJECTS } from './text-schema';

/** Fold Russian letters even on C-locale clusters; original text and receipt bytes stay untouched. */
export const PROJECT_TEXT_SEARCH_SCHEMA = `
CREATE FUNCTION public.neurocenter_text_search_fold(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,public AS $$
    SELECT lower(translate(value,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя'));
$$;
DROP INDEX public.project_text_search_idx;
ALTER TABLE public.project_text_documents DROP COLUMN search_vector;
ALTER TABLE public.project_text_documents ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,public.neurocenter_text_search_fold(path||E'\\n'||content))) STORED;
CREATE INDEX project_text_search_idx ON public.project_text_documents USING gin(search_vector);
`;
export const PROJECT_TEXT_SEARCH_OBJECTS = {
    ...PROJECT_TEXT_OBJECTS,
    functions: [...PROJECT_TEXT_OBJECTS.functions, 'neurocenter_text_search_fold'],
};
