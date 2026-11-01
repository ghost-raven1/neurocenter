/** Parsed metadata remains untrusted until normalization. */
export interface IParsedSkillFile {
    meta?: Record<string, unknown>;
    body: string;
}
