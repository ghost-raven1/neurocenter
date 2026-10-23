export const OPEN_CHAT_EVENT='neurocenter:open-chat';
export interface IChatLaunch {projectId?:string;group?:boolean;team?:boolean;}

/** A direct entry from project agents opens the one header overlay without changing routes. */
export function openModelChat(value:IChatLaunch={}):void {window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT,{detail:value}));}

/** The overlay captures route context once; navigating underneath never rewrites an open draft. */
export function routeChatProject(pathname:string,search:string):string|undefined {
    const match=/^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
    if(match){try{return decodeURIComponent(match[1]);}catch{return undefined;}}
    return new URLSearchParams(search).get('p')||undefined;
}
