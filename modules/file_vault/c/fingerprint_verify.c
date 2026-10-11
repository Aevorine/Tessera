/* Windows Hello 验证（IUserConsentVerifierInterop）+ WinBio 模态探测。
   1) fingerprint_verify.exe <hwnd_hex> [--timeout-ms=N]（默认 90000，本进程自己的期限），
      stdin 首行为提示文字；stdout 一行 Verified(0) / Canceled(1) / Error: <detail>(2)，退出码同。
      stdin 须保持打开，写 "CANCEL" 或 EOF 即取消。
   不能被外部杀掉：弹窗对 HWND 模态，进程被杀则宿主窗口永久点不了，故自带期限与 CANCEL 通道。
   等待循环必须泵消息：STA 不分发则 broker 回调送不进来，状态永远 Started。
   2) --modalities：每行 key=0|1（face / fingerprint / iris），永不失败。 */

/* 显式设 Windows 10 (0x0A00)：GetTickCount64 / MsgWaitForMultipleObjectsEx 受
   _WIN32_WINNT 限制，MinGW 默认值更低。 */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>
#include <initguid.h>           /* must come before any DEFINE_GUID */
#include <roapi.h>
#include <hstring.h>
#include <winstring.h>
#include <inspectable.h>
#include <windows.foundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>          /* strcmp, for the --modalities switch */

/* ------------------------------------------------------------------ */
/* Windows Biometric Framework — declared by hand.                     */
/*                                                                     */
/* MinGW-w64 8.1 ships neither winbio.h nor libwinbio.a, so the two    */
/* entry points we need are resolved from winbio.dll at runtime. That  */
/* is not just a workaround for the missing import library: winbio.dll */
/* is absent on Server SKUs and on installs without the Biometric      */
/* Service, and a load-time import would make this whole executable    */
/* fail to start there — taking Hello verification down with it, even  */
/* though verification does not need WinBio at all.                    */
/*                                                                     */
/* WINBIO_UNIT_SCHEMA's layout is 5×ULONG + 5×WCHAR[256] + 2×ULONG =   */
/* 2588 bytes, all 4-byte aligned so no padding is implied. A          */
/* compile-time assert below pins that down: if a future toolchain     */
/* disagrees, the build breaks instead of silently reading garbage out */
/* of a misaligned array.                                              */
/* ------------------------------------------------------------------ */
#define WINBIO_TYPE_FACIAL_FEATURES 0x00000002u
#define WINBIO_TYPE_FINGERPRINT     0x00000008u
#define WINBIO_TYPE_IRIS            0x00000010u
#define WINBIO_TYPE_ANY             0x00FFFFFFu

typedef struct _WINBIO_VERSION {
    ULONG MajorVersion;
    ULONG MinorVersion;
} WINBIO_VERSION;

typedef struct _WINBIO_UNIT_SCHEMA {
    ULONG          UnitId;
    ULONG          PoolType;
    ULONG          BiometricFactor;
    ULONG          SensorSubType;
    ULONG          Capabilities;
    WCHAR          DeviceInstanceId[256];
    WCHAR          Description[256];
    WCHAR          Manufacturer[256];
    WCHAR          Model[256];
    WCHAR          SerialNumber[256];
    WINBIO_VERSION FirmwareVersion;
} WINBIO_UNIT_SCHEMA;

typedef int winbio_schema_size_assert[
    (sizeof(WINBIO_UNIT_SCHEMA) == 2588) ? 1 : -1];

typedef HRESULT (WINAPI *PFN_WinBioEnumBiometricUnits)(
    ULONG Factor, WINBIO_UNIT_SCHEMA **UnitSchemaArray, SIZE_T *UnitCount);
typedef HRESULT (WINAPI *PFN_WinBioFree)(void *Address);

/* ------------------------------------------------------------------ */
/* Manually‑defined interop interface (not shipped in MinGW headers).  */
/* IUserConsentVerifierInterop  {39E050C3‑4E74‑441A‑8DC0‑B81104DF949C} */
/* ------------------------------------------------------------------ */
static const GUID IID_IUserConsentVerifierInterop =
    {0x39E050C3, 0x4E74, 0x441A, {0x8D,0xC0, 0xB8,0x11,0x04,0xDF,0x94,0x9C}};

typedef struct IUserConsentVerifierInterop IUserConsentVerifierInterop;

typedef struct IUserConsentVerifierInteropVtbl {
    BEGIN_INTERFACE

    /* IUnknown */
    HRESULT (STDMETHODCALLTYPE *QueryInterface)(
        IUserConsentVerifierInterop *This,
        REFIID riid, void **ppvObject);
    ULONG (STDMETHODCALLTYPE *AddRef)(IUserConsentVerifierInterop *This);
    ULONG (STDMETHODCALLTYPE *Release)(IUserConsentVerifierInterop *This);

    /* IInspectable */
    HRESULT (STDMETHODCALLTYPE *GetIids)(
        IUserConsentVerifierInterop *This, ULONG *iidCount, IID **iids);
    HRESULT (STDMETHODCALLTYPE *GetRuntimeClassName)(
        IUserConsentVerifierInterop *This, HSTRING *className);
    HRESULT (STDMETHODCALLTYPE *GetTrustLevel)(
        IUserConsentVerifierInterop *This, TrustLevel *trustLevel);

    /* IUserConsentVerifierInterop */
    HRESULT (STDMETHODCALLTYPE *RequestVerificationForWindowAsync)(
        IUserConsentVerifierInterop *This,
        HWND appWindow,
        HSTRING message,
        REFIID riid,
        void **asyncOperation);

    END_INTERFACE
} IUserConsentVerifierInteropVtbl;

struct IUserConsentVerifierInterop {
    CONST_VTBL IUserConsentVerifierInteropVtbl *lpVtbl;
};

/* ------------------------------------------------------------------ */
/* IAsyncOperation<UserConsentVerificationResult> — the REAL vtable    */
/* shape for this specific instantiation, byte-verified against the   */
/* actual Windows SDK header windows.security.credentials.ui.h        */
/* (__FIAsyncOperation_1_..._UserConsentVerificationResult, SDK        */
/* 10.0.14393.0): GetResults(This, /out/ INT32*) -> HRESULT.           */
/*                                                                     */
/* Do NOT reuse the <windows.foundation.h> IAsyncOperation that MinGW  */
/* ships — it is a same-named but DIFFERENT placeholder (modeled after */
/* a no-result async action) whose GetResults takes only `This` and    */
/* returns IInspectable* directly. QueryInterface with the correct     */
/* IID below still succeeds against that wrong C type, so the mismatch */
/* doesn't fail loudly: the missing 2nd argument reads whatever was    */
/* left in that register, and the real HRESULT return value gets      */
/* misread as an IInspectable* pointer (almost always NULL, since      */
/* S_OK==0) — which is what was silently turning every successful      */
/* Windows Hello prompt into a hard-coded "GetResults returned NULL"   */
/* followed by a generic "verification failed", regardless of whether  */
/* the fingerprint actually matched. IID unchanged/confirmed correct.  */
/* ------------------------------------------------------------------ */
static const GUID kIID_AsyncOp_VerificationResult = {
    0xfd596ffd, 0x2318, 0x558f,
    {0x9d,0xbe, 0xd2,0x1d,0xf4,0x37,0x64,0xa5}
};

typedef struct IAsyncOperationVerificationResult IAsyncOperationVerificationResult;

typedef struct IAsyncOperationVerificationResultVtbl {
    BEGIN_INTERFACE

    /* IUnknown */
    HRESULT (STDMETHODCALLTYPE *QueryInterface)(
        IAsyncOperationVerificationResult *This, REFIID riid, void **ppvObject);
    ULONG (STDMETHODCALLTYPE *AddRef)(IAsyncOperationVerificationResult *This);
    ULONG (STDMETHODCALLTYPE *Release)(IAsyncOperationVerificationResult *This);

    /* IInspectable */
    HRESULT (STDMETHODCALLTYPE *GetIids)(
        IAsyncOperationVerificationResult *This, ULONG *iidCount, IID **iids);
    HRESULT (STDMETHODCALLTYPE *GetRuntimeClassName)(
        IAsyncOperationVerificationResult *This, HSTRING *className);
    HRESULT (STDMETHODCALLTYPE *GetTrustLevel)(
        IAsyncOperationVerificationResult *This, TrustLevel *trustLevel);

    /* put_Completed / get_Completed 从不调用（改轮询 IAsyncInfo::get_Status），
       handler 参数用不透明指针，只需 vtable 槽位对齐。 */
    HRESULT (STDMETHODCALLTYPE *put_Completed)(
        IAsyncOperationVerificationResult *This, void *handler);
    HRESULT (STDMETHODCALLTYPE *get_Completed)(
        IAsyncOperationVerificationResult *This, void **handler);
    HRESULT (STDMETHODCALLTYPE *GetResults)(
        IAsyncOperationVerificationResult *This, INT32 *results);

    END_INTERFACE
} IAsyncOperationVerificationResultVtbl;

struct IAsyncOperationVerificationResult {
    CONST_VTBL IAsyncOperationVerificationResultVtbl *lpVtbl;
};

/* ------------------------------------------------------------------ */
/* Runtime class name.                                                 */
/* ------------------------------------------------------------------ */
static const WCHAR kUserConsentVerifier[] =
    L"Windows.Security.Credentials.UI.UserConsentVerifier";

/* ------------------------------------------------------------------ */
/* print_error — helper, always writes to stderr                      */
/* ------------------------------------------------------------------ */
static void print_error(const char *prefix, HRESULT hr)
{
    fprintf(stderr, "%s: 0x%08lx\n", prefix, hr);
}

/* ------------------------------------------------------------------ */
/* Cooperative cancellation                                            */
/*                                                                     */
/* Set from the stdin watcher thread, read from the wait loop. A plain */
/* volatile LONG through the Interlocked* helpers is enough — there is */
/* exactly one writer, one reader, and one bit of state.               */
/* ------------------------------------------------------------------ */
static volatile LONG g_cancelRequested = 0;

#define DEFAULT_TIMEOUT_MS 90000u
/* 请求取消后继续泵消息的宽限期；仅防 broker 卡死让"取消"变成新的无限挂起。 */
#define CANCEL_GRACE_MS 2000u

/* 直接读原始 stdin HANDLE 的一行（EOF 且无数据返回 -1），绕开 CRT 的 stdin：
   取消监视线程阻塞在读上会持有 CRT 流锁，main 返回时 exit() 清理要同一把锁，进程永不退出。
   逐字节 ReadFile 无妨，协议只有提示串和偶尔的 "CANCEL"。 */
static int read_line_raw(HANDLE h, char *buf, size_t cap)
{
    size_t n = 0;
    for (;;) {
        char ch;
        DWORD got = 0;
        if (!ReadFile(h, &ch, 1, &got, NULL) || got == 0) {
            /* EOF or a broken pipe. A partial line still counts as a line;
               only "nothing at all" reports EOF. */
            if (n == 0) return -1;
            break;
        }
        if (ch == '\n') break;
        if (ch == '\r') continue;
        if (n + 1 < cap) buf[n++] = ch;
    }
    buf[n] = '\0';
    return (int)n;
}

/* 读提示后的 stdin；"CANCEL" 行或 EOF 都请求取消。EOF 算取消是有意的：
   父进程没了就没人收结果，不能把模态凭据框留在孤儿窗口上。
   要跑完的调用方必须保持 stdin 打开（fingerprint.py 因此不用 subprocess.run(input=...)）。 */
static DWORD WINAPI stdin_watch_thread(LPVOID param)
{
    HANDLE h = (HANDLE)param;
    char line[32];
    for (;;) {
        if (read_line_raw(h, line, sizeof(line)) < 0) break;   /* EOF */
        if (_stricmp(line, "CANCEL") == 0) break;
    }
    InterlockedExchange(&g_cancelRequested, 1);
    return 0;
}

/* 一个泵消息的等待片段；nCount == 0 时有输入返回 WAIT_OBJECT_0，否则 WAIT_TIMEOUT。 */
static void pump_messages(DWORD waitMs)
{
    DWORD r = MsgWaitForMultipleObjectsEx(0, NULL, waitMs, QS_ALLINPUT,
                                          MWMO_INPUTAVAILABLE);
    if (r == WAIT_OBJECT_0) {
        MSG msg;
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/* Cancel() 必须在泵消息线程之外调用：它是跨 apartment 调用，broker 可能要本 STA 分发才应答，
   内联调用实测会有时阻塞不返回。放工作线程，主线程继续泵，按时收尾。 */
static DWORD WINAPI cancel_thread(LPVOID param)
{
    IAsyncInfo *asyncInfo = (IAsyncInfo *)param;
    asyncInfo->lpVtbl->Cancel(asyncInfo);
    return 0;
}

/* 泵消息等待异步操作离开 Started，返回终态；*outReason：0 自行完成，1 调用方取消，2 自身期限到。
   1/2 时仍请求取消并继续泵 CANCEL_GRACE_MS：干净收尾才能关弹窗并恢复宿主窗口。 */
static AsyncStatus wait_for_async(IAsyncInfo *asyncInfo, DWORD timeoutMs, int *outReason)
{
    ULONGLONG deadline = GetTickCount64() + (ULONGLONG)timeoutMs;
    AsyncStatus status = 0; /* Started */
    int reason = 0;

    for (;;) {
        if (FAILED(asyncInfo->lpVtbl->get_Status(asyncInfo, &status))) break;
        if (status != 0) break;
        if (InterlockedCompareExchange(&g_cancelRequested, 0, 0) != 0) { reason = 1; break; }
        if (GetTickCount64() >= deadline) { reason = 2; break; }
        pump_messages(50);
    }

    if (reason != 0) {
        HANDLE canceller = CreateThread(NULL, 0, cancel_thread, asyncInfo, 0, NULL);
        ULONGLONG graceUntil = GetTickCount64() + CANCEL_GRACE_MS;
        while (GetTickCount64() < graceUntil) {
            if (FAILED(asyncInfo->lpVtbl->get_Status(asyncInfo, &status))) break;
            if (status != 0) break;
            pump_messages(50);
        }
        if (canceller) CloseHandle(canceller);
    }

    *outReason = reason;
    return status;
}

/* ------------------------------------------------------------------ */
/* probe_modalities                                                    */
/*                                                                     */
/* Prints which biometric modalities this machine has hardware for.    */
/*                                                                     */
/* What this does NOT tell you: whether the user has actually enrolled */
/* that modality. Windows exposes enrolment only through a WinBio      */
/* session plus WinBioEnumEnrolledUsers, which needs the sensor to be  */
/* opened and can prompt/park on some drivers — far too heavy to run   */
/* on every login-screen mount. The caller therefore treats this as    */
/* "hardware present", and pairs it with UserConsentVerifier's         */
/* availability check ("Hello is set up for this user") before         */
/* claiming a modality is usable. Getting that pairing wrong in the    */
/* optimistic direction is harmless: the factor chain silently drops   */
/* to the next entry the moment a verification comes back unusable.    */
/* ------------------------------------------------------------------ */
static int probe_modalities(void)
{
    int haveFace = 0, haveFinger = 0, haveIris = 0;

    HMODULE lib = LoadLibraryW(L"winbio.dll");
    if (lib) {
        PFN_WinBioEnumBiometricUnits pEnum =
            (PFN_WinBioEnumBiometricUnits)(void *)
                GetProcAddress(lib, "WinBioEnumBiometricUnits");
        PFN_WinBioFree pFree =
            (PFN_WinBioFree)(void *)GetProcAddress(lib, "WinBioFree");

        if (pEnum && pFree) {
            WINBIO_UNIT_SCHEMA *units = NULL;
            SIZE_T count = 0;
            /* 用 WINBIO_TYPE_ANY 一次枚举：少一次往返，未知的新因子落入 switch 默认而不被漏掉。 */
            if (SUCCEEDED(pEnum(WINBIO_TYPE_ANY, &units, &count)) && units) {
                for (SIZE_T i = 0; i < count; i++) {
                    switch (units[i].BiometricFactor) {
                    case WINBIO_TYPE_FACIAL_FEATURES: haveFace = 1;   break;
                    case WINBIO_TYPE_FINGERPRINT:     haveFinger = 1; break;
                    case WINBIO_TYPE_IRIS:            haveIris = 1;   break;
                    default: break;   /* voice, vein, … — not offered as unlock factors */
                    }
                }
                pFree(units);
            }
        }
        FreeLibrary(lib);
    }

    printf("face=%d\n", haveFace);
    printf("fingerprint=%d\n", haveFinger);
    printf("iris=%d\n", haveIris);
    fflush(stdout);
    return 0;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <hwnd> [--timeout-ms=N] | --modalities\n", argv[0]);
        fprintf(stderr, "  Reads the prompt message from stdin (UTF-8), one line.\n");
        fflush(stderr);
        return 2;
    }

    /* 探测先于 WinRT 初始化：不需要父窗口和 apartment，登录界面还没有窗口句柄时也要能用。 */
    if (strcmp(argv[1], "--modalities") == 0) {
        return probe_modalities();
    }

    /* Parse HWND — accept decimal or 0x-prefixed hex. */
    HWND hwnd;
    {
        char *p = argv[1];
        int base = 10;
        if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) {
            base = 16;
            p += 2;
        }
        hwnd = (HWND)(ULONG_PTR)strtoull(p, NULL, base);
    }

    /* 过期或无效的句柄（窗口已关、argv 错误）传给 RequestVerificationForWindowAsync
       会段错误，必须先拦。 */
    if (hwnd == NULL || !IsWindow(hwnd)) {
        fprintf(stderr, "Error: invalid_hwnd\n");
        fflush(stderr);
        return 2;
    }

    /* 无法解析的值回退默认期限而非"无超时"，避免调用方笔误让无限挂起复现。 */
    DWORD timeoutMs = DEFAULT_TIMEOUT_MS;
    for (int i = 2; i < argc; i++) {
        if (strncmp(argv[i], "--timeout-ms=", 13) == 0) {
            unsigned long long v = strtoull(argv[i] + 13, NULL, 10);
            if (v >= 1000ULL && v <= 600000ULL) timeoutMs = (DWORD)v;
        }
    }

    /* 从 stdin 读提示文字（避开 argv 编码弄坏中文）。用原始 handle 而非 CRT 的 stdin：
       下面的监视线程会继续读同一管道，混用带缓冲的 FILE 既丢字节又会重现退出死锁。 */
    HANDLE hStdin = GetStdHandle(STD_INPUT_HANDLE);
    char stdinBuf[2048] = {0};
    read_line_raw(hStdin, stdinBuf, sizeof(stdinBuf));
    const char *message = stdinBuf[0] ? stdinBuf : "请验证指纹以解锁 Tessera";

    /* 提示行之后的 stdin 都是取消通道；在 WinRT 调用前启动，免得 broker 启动期间的取消丢失。 */
    {
        HANDLE watcher = CreateThread(NULL, 0, stdin_watch_thread, hStdin, 0, NULL);
        if (watcher) CloseHandle(watcher);  /* fire and forget; process exit reaps it */
    }

    /* ---------- WinRT initialisation ---------- */
    HRESULT hr = RoInitialize(RO_INIT_SINGLETHREADED);
    /* 接受 S_OK、S_FALSE（已初始化）和 RPC_E_CHANGED_MODE（线程模型不同，但其分发泵仍能处理本调用）
    。 */
    if (FAILED(hr) && hr != (HRESULT)0x80010106L
                   && (ULONG)hr != 1) {
        print_error("RoInitialize failed", hr);
        return 2;
    }

    /* ---------- Create HSTRING for the class name ---------- */
    HSTRING classIdH;
    hr = WindowsCreateString(kUserConsentVerifier,
                             (UINT32)wcslen(kUserConsentVerifier),
                             &classIdH);
    if (FAILED(hr)) {
        print_error("WindowsCreateString(class)", hr);
        RoUninitialize();
        return 2;
    }

    /* ---------- Get IUserConsentVerifierInterop ---------- */
    IUserConsentVerifierInterop *interop = NULL;
    hr = RoGetActivationFactory(classIdH, &IID_IUserConsentVerifierInterop,
                                (void **)&interop);
    WindowsDeleteString(classIdH);
    if (FAILED(hr)) {
        print_error("RoGetActivationFactory", hr);
        RoUninitialize();
        return 2;
    }

    /* ---------- Create HSTRING for the prompt message ---------- */
    /* Convert UTF‑8 → wide string */
    int wlen = MultiByteToWideChar(CP_UTF8, 0, message, -1, NULL, 0);
    if (wlen == 0) {
        interop->lpVtbl->Release(interop);
        print_error("MultiByteToWideChar", (HRESULT)GetLastError());
        RoUninitialize();
        return 2;
    }
    WCHAR *wmsg = (WCHAR *)malloc((size_t)wlen * sizeof(WCHAR));
    if (!wmsg) {
        interop->lpVtbl->Release(interop);
        fprintf(stderr, "malloc failed\n");
        RoUninitialize();
        return 2;
    }
    MultiByteToWideChar(CP_UTF8, 0, message, -1, wmsg, wlen);

    HSTRING msgH;
    hr = WindowsCreateString(wmsg, (UINT32)(wlen - 1), &msgH);
    free(wmsg);
    if (FAILED(hr)) {
        interop->lpVtbl->Release(interop);
        print_error("WindowsCreateString(msg)", hr);
        RoUninitialize();
        return 2;
    }

    /* ---------- Fire the verification ---------- */
    /* 先请求 IAsyncInfo：参数化的 IAsyncOperation GUID 可能导致 vtable 不匹配，GetResults 时再 QI。
     */
    IAsyncInfo *asyncInfo = NULL;
    hr = interop->lpVtbl->RequestVerificationForWindowAsync(
        interop, hwnd, msgH, &IID_IAsyncInfo, (void **)&asyncInfo);
    WindowsDeleteString(msgH);
    interop->lpVtbl->Release(interop);  /* no longer needed */
    if (FAILED(hr)) {
        print_error("RequestVerificationForWindowAsync", hr);
        RoUninitialize();
        return 2;
    }

    /* 通过基类 IAsyncInfo vtable 等待（IAsyncOperation<T> 都继承它，布局固定），
       全程泵消息，并同时响应取消通道和自身期限。 */
    int exitCode = 2;
    const char *outLine = NULL;
    int stopReason = 0;
    AsyncStatus asyncStatus = wait_for_async(asyncInfo, timeoutMs, &stopReason);

    if (stopReason == 2) {
        /* 自身期限到；调用方把该 token 映射为 fingerprint.verification_timeout。由本进程报告而非
           父进程杀掉，凭据 UI 才能收到真正的 Cancel()，宿主窗口才会恢复可用。 */
        fprintf(stderr, "Error: verification_timeout\n");
        goto cleanup;
    }
    if (stopReason == 1) {
        /* 调用方撤回请求（点取消、换因子、应用退出），等同用户关掉对话框，报 Canceled 而非错误。 */
        outLine = "Canceled";
        exitCode = 1;
        goto cleanup;
    }

    /* Only proceed if the async operation actually completed. */
    if (asyncStatus == 1 /* Completed */) {
        /* 正常完成（Verified 或 Canceled）：QI 到形状正确的参数化接口（不能用 MinGW 通用的
           <windows.foundation.h> IAsyncOperation，原因见类型定义处），直接读结果。 */
        IAsyncOperationVerificationResult *typedOp = NULL;
        hr = asyncInfo->lpVtbl->QueryInterface(asyncInfo,
                &kIID_AsyncOp_VerificationResult, (void **)&typedOp);
        if (FAILED(hr)) {
            print_error("QI to IAsyncOperation<UserConsentVerificationResult>", hr);
            goto cleanup;
        }

        INT32 value = -1;
        hr = typedOp->lpVtbl->GetResults(typedOp, &value);
        typedOp->lpVtbl->Release(typedOp);
        if (FAILED(hr)) {
            print_error("GetResults", hr);
            fprintf(stderr, "Error: get_results_failed\n");
            goto cleanup;
        }

        exitCode = 2;
        switch (value) {
        case 0:
            outLine = "Verified";
            exitCode = 0;
            break;
        case 6:
            outLine = "Canceled";
            exitCode = 1;
            break;
        /* 其余值是系统级失败而非是/否：输出 fingerprint.py 按子串匹配的确切 token
           （见其 request_verification_for_window 文档和同目录 fingerprint_verify.ps1 的映射）。 */
        case 1:
            fprintf(stderr, "Error: device_not_present\n");
            goto cleanup;
        case 2:
            fprintf(stderr, "Error: not_configured\n");
            goto cleanup;
        case 3:
            fprintf(stderr, "Error: disabled_by_policy\n");
            goto cleanup;
        case 4:
            fprintf(stderr, "Error: device_busy\n");
            goto cleanup;
        case 5:
            fprintf(stderr, "Error: retries_exhausted\n");
            goto cleanup;
        default:
            fprintf(stderr, "Error: verification_result=%d\n", value);
            goto cleanup;
        }
    } else if (asyncStatus == 2 /* Canceled */) {
        outLine = "Canceled";
        exitCode = 1;
    } else {
        HRESULT errorCode = 0;
        asyncInfo->lpVtbl->get_ErrorCode(asyncInfo, &errorCode);
        fprintf(stderr, "Error: async_status=%d error=0x%08lx\n",
                (int)asyncStatus, errorCode);
        goto cleanup;
    }

cleanup:
    if (outLine) {
        printf("%s\n", outLine);
        fflush(stdout);
    }
    asyncInfo->lpVtbl->Release(asyncInfo);
    RoUninitialize();

    /* 用 ExitProcess 而非 return：监视线程还卡在可能永不来数据的 ReadFile 上，CRT 正常收尾
       不该等它；需要输出的内容上面都已 flush。 */
    fflush(stdout);
    fflush(stderr);
    ExitProcess((UINT)exitCode);
}
