/** Logs may contain secrets and hostile terminal text; return evidence with conservative redaction. */
export function redactLog(value){
    let text=value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
    text=text.replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,'[PRIVATE KEY REDACTED]')
        .replace(/^[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,'[PRIVATE KEY REDACTED]')
        .replace(/^[A-Za-z0-9+/=]{32,}\s*$/gm,'[OPAQUE DATA REDACTED]');
    text=text.replace(/\b(?:https?|postgres(?:ql)?|redis|mysql):\/\/[^\s<>"']+/gi,raw=>{
        try{const url=new URL(raw);if(url.username||url.password){url.username='REDACTED';url.password='';}if(url.search)url.search='REDACTED';if(url.hash)url.hash='REDACTED';return url.toString();}
        catch{return '[URL REDACTED]';}
    });
    text=text.replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]+/gi,'$1[REDACTED]')
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'[AUTH REDACTED]')
        .replace(/((?:["']?)(?:password|passwd|api[_-]?key|client[_-]?secret|secret|(?:(?:access|refresh)[_-]?)?token|credential)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,'$1[REDACTED]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,'[API CREDENTIAL REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[JWT REDACTED]');
    return text;
}
