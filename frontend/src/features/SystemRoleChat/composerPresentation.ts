/** Long feedback stays readable in full without permanently taking the message viewport. */
export function serviceFeedbackText(value:string):{summary:string;detail?:string}{
    const line=value.trim().replace(/\s+/g,' '),characters=Array.from(line);
    return characters.length>180||value.split('\n').length>2
        ?{summary:characters.slice(0,180).join('')+(characters.length>180?'…':''),detail:value}
        :{summary:line};
}
