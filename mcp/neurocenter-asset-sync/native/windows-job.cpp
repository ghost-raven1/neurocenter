#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <vector>
#include <cerrno>
#include <cstdlib>

// Экранирование argv по правилам CommandLineToArgvW, без cmd.exe или shell.
static std::wstring quote(const wchar_t* source) {
    std::wstring result=L"\""; unsigned slashes=0;
    for(const wchar_t* p=source; *p; ++p) {
        if(*p==L'\\') {++slashes; continue;}
        if(*p==L'"') {result.append(slashes*2+1,L'\\'); result+=L'"'; slashes=0; continue;}
        result.append(slashes,L'\\'); slashes=0; result+=*p;
    }
    result.append(slashes*2,L'\\'); return result+L"\"";
}

// Только собственный suspended child попадает в Job до выполнения первой инструкции.
int wmain(int argc,wchar_t** argv) {
    if(argc<5 || std::wstring(argv[1])!=L"--parent-pid" || std::wstring(argv[3])!=L"--") return 64;
    wchar_t* end=nullptr; errno=0; const unsigned long parentPid=wcstoul(argv[2],&end,10);
    if(errno || !end || *end || !parentPid) return 64;
    HANDLE parent=OpenProcess(SYNCHRONIZE,FALSE,static_cast<DWORD>(parentPid));
    if(!parent) return 70;
    HANDLE job=CreateJobObjectW(nullptr,nullptr);
    if(!job) {CloseHandle(parent); return 70;}
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) {CloseHandle(job); CloseHandle(parent); return 70;}
    std::wstring command;
    for(int i=4;i<argc;++i) {if(i>4) command+=L' '; command+=quote(argv[i]);}
    std::vector<wchar_t> mutableCommand(command.begin(),command.end()); mutableCommand.push_back(0);
    STARTUPINFOW startup{}; startup.cb=sizeof(startup); startup.dwFlags=STARTF_USESTDHANDLES;
    startup.hStdInput=GetStdHandle(STD_INPUT_HANDLE); startup.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE); startup.hStdError=GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION process{};
    if(WaitForSingleObject(parent,0)!=WAIT_TIMEOUT) {CloseHandle(job); CloseHandle(parent); return 125;}
    if(!CreateProcessW(argv[4],mutableCommand.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,nullptr,nullptr,&startup,&process)) {CloseHandle(job); CloseHandle(parent); return 71;}
    if(!AssignProcessToJobObject(job,process.hProcess)) {TerminateProcess(process.hProcess,72); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); CloseHandle(parent); return 72;}
    if(WaitForSingleObject(parent,0)!=WAIT_TIMEOUT) {TerminateJobObject(job,125); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); CloseHandle(parent); return 125;}
    if(ResumeThread(process.hThread)==static_cast<DWORD>(-1)) {TerminateJobObject(job,73); CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); CloseHandle(parent); return 73;}
    CloseHandle(process.hThread);
    // Смерть собственного Node-родителя закрывает Job даже без finally/таймера JavaScript.
    HANDLE observed[]={process.hProcess,parent}; const DWORD state=WaitForMultipleObjects(2,observed,FALSE,INFINITE);
    DWORD code=74; if(state==WAIT_OBJECT_0) {GetExitCodeProcess(process.hProcess,&code);} else {code=125;}
    CloseHandle(job); CloseHandle(process.hProcess); CloseHandle(parent); return static_cast<int>(code);
}
