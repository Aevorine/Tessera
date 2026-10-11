/*
 * file_clip 键盘/鼠标钩子代理（C 版）：接管资源管理器的 Ctrl+C/X/V、Delete，
 * 以及原生工具栏/右键菜单图标行的「粘贴」「删除」按钮。
 *
 * 用 C 是因为低级钩子让全系统输入都经过本进程，Python 版的 GIL/GC 暂停会卡死输入。
 * 用法: hook_agent.exe <pythonw.exe> <cli.py> [重名策略] [UIA扫描脚本]；--stop 停止实例。
 *
 * 键盘：粘贴需修饰键精确匹配、非注入、前台是资源管理器/桌面、剪贴板是 CF_HDROP、
 * 焦点在文件列表区（重命名框/地址栏放行）。Delete=回收站，Shift+Delete=永久删除
 * （Python 侧先弹确认框）；桌面的删除键不接管。五个组合键启动时读一次
 * %TEMP%\file_clip_shortcuts.txt（行格式"动作名 VK码 ctrl alt shift"），改键靠重启
 * 本代理，刻意不热加载以免钩子回调路径出现共享状态；缺文件/坏行用内置默认。
 *
 * 鼠标：原生按钮无法安全替换，也绝不注入 explorer.exe。常驻 PowerShell 子进程
 * （ui_scan_agent.ps1）用 UIA 扫出按钮矩形写临时文件，本进程每 150ms 重读到内存；
 * WH_MOUSE_LL 钩子只判断左键按下坐标是否命中矩形，命中才吞掉并拉起 Python，
 * 钩子路径上绝不做 UIA/COM 调用。命中前用 IsWindow + 类名兜底校验，防缓存过期误吞。
 * 点删除按钮按回收站语义，按住 Shift 才永久删除。未传第 4 个参数或文件不存在时
 * 不装鼠标钩子（native-buttons-off 即靠此关闭）。
 *
 * 编译: gcc -O2 -municode -mwindows -o hook_agent.exe hook_agent.c -luser32 -lshell32
 */

#define __USE_MINGW_ANSI_STDIO 1

#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>

#define MUTEX_NAME L"Local\\file_clip_hook_agent"
#define STOP_EVENT_NAME L"Local\\file_clip_hook_stop"
#define MAX_RECTS 64
#define RECT_RELOAD_MS 150

static WCHAR g_pythonw[MAX_PATH];
static WCHAR g_cli[MAX_PATH];
static WCHAR g_conflict[16] = L"rename";
static WCHAR g_ps1path[MAX_PATH] = L"";
static WCHAR g_rects_path[MAX_PATH] = L"";
static WCHAR g_log_path[MAX_PATH] = L"";
static WCHAR g_status_path[MAX_PATH] = L"";
static HHOOK g_hook = NULL;
static HHOOK g_mouse_hook = NULL;
static HANDLE g_scanner_proc = NULL;
static HANDLE g_reload_thread = NULL;
static volatile LONG g_reload_stop = 0;
static CRITICAL_SECTION g_rects_cs;
static BOOL g_mouse_enabled = FALSE;

typedef struct {
    BOOL is_paste;
    HWND owner;
    RECT r;
} HotRect;

static HotRect g_rects[MAX_RECTS];
static int g_rect_count = 0;

static BOOL key_down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

/* 可自定义的键盘组合键（粘贴/删除/彻底删除）：默认值同旧版硬编码；
   load_shortcut_bindings() 装钩子前读一次，此后只读，回调里无写共享状态的路径。 */
typedef struct {
    int vk;
    BOOL ctrl;
    BOOL alt;
    BOOL shift;
} KeyBinding;

static KeyBinding g_bind_copy          = { 'C',       TRUE,  FALSE, FALSE };
static KeyBinding g_bind_cut           = { 'X',       TRUE,  FALSE, FALSE };
static KeyBinding g_bind_paste         = { 'V',       TRUE,  FALSE, FALSE };
static KeyBinding g_bind_del_recycle   = { VK_DELETE, FALSE, FALSE, FALSE };
static KeyBinding g_bind_del_permanent = { VK_DELETE, FALSE, FALSE, TRUE  };

/* 修饰键精确匹配；按下 Win 键或程序注入的按键一律放行（防死循环）。
   Alt 用钩子事件自带的 LLKHF_ALTDOWN。 */
static BOOL binding_matches(const KeyBinding *b, const KBDLLHOOKSTRUCT *k)
{
    BOOL alt_down = (k->flags & LLKHF_ALTDOWN) ? TRUE : FALSE;
    if ((int)k->vkCode != b->vk) return FALSE;
    if (k->flags & LLKHF_INJECTED) return FALSE;
    if (alt_down != b->alt) return FALSE;
    if (key_down(VK_CONTROL) != b->ctrl) return FALSE;
    if (key_down(VK_SHIFT) != b->shift) return FALSE;
    if (key_down(VK_LWIN) || key_down(VK_RWIN)) return FALSE;
    return TRUE;
}

static BOOL fg_class_ok(const WCHAR *cls)
{
    return wcscmp(cls, L"CabinetWClass") == 0 || wcscmp(cls, L"ExploreWClass") == 0 ||
           wcscmp(cls, L"Progman") == 0 || wcscmp(cls, L"WorkerW") == 0;
}

/* 删除键/删除按钮只接管真正的资源管理器文件窗口，不碰桌面 */
static BOOL explorer_class_ok(const WCHAR *cls)
{
    return wcscmp(cls, L"CabinetWClass") == 0 || wcscmp(cls, L"ExploreWClass") == 0;
}

static BOOL focus_class_ok(HWND fg)
{
    GUITHREADINFO gi;
    WCHAR cls[64] = L"";
    DWORD tid = GetWindowThreadProcessId(fg, NULL);
    ZeroMemory(&gi, sizeof(gi));
    gi.cbSize = sizeof(gi);
    if (!GetGUIThreadInfo(tid, &gi) || !gi.hwndFocus)
        return FALSE; /* 拿不到焦点信息 → 保守放行 */
    GetClassNameW(gi.hwndFocus, cls, 64);
    return wcscmp(cls, L"DirectUIHWND") == 0 || wcscmp(cls, L"SysListView32") == 0;
}

/* 诊断日志：只在真正吞掉一次点击时写一行，内容全 ASCII，纯文本模式足够，
   不需要处理编码。找不到日志文件路径（鼠标接管没启用）就直接跳过。 */
static void log_line(const WCHAR *fmt, ...)
{
    if (!g_log_path[0]) return;
    FILE *f = _wfopen(g_log_path, L"a");
    if (!f) return;
    va_list ap;
    va_start(ap, fmt);
    vfwprintf(f, fmt, ap);
    va_end(ap);
    fwprintf(f, L"\n");
    fclose(f);
}

static void init_status_path(void)
{
    WCHAR local_app_data[MAX_PATH];
    WCHAR ideal_root[MAX_PATH];
    WCHAR hook_root[MAX_PATH];
    if (SUCCEEDED(SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, local_app_data))) {
        _snwprintf(ideal_root, MAX_PATH, L"%ls\\Tessera", local_app_data);
        CreateDirectoryW(ideal_root, NULL);
        _snwprintf(hook_root, MAX_PATH, L"%ls\\FileHook", ideal_root);
        CreateDirectoryW(hook_root, NULL);
        _snwprintf(g_status_path, MAX_PATH, L"%ls\\file_clip_hook_status.txt", hook_root);
        return;
    }
    GetTempPathW(MAX_PATH, local_app_data);
    _snwprintf(g_status_path, MAX_PATH, L"%lsfile_clip_hook_status.txt", local_app_data);
}

static void write_status(const WCHAR *state, DWORD error_code)
{
    FILE *f;
    if (!g_status_path[0]) init_status_path();
    f = _wfopen(g_status_path, L"w");
    if (!f) return;
    fwprintf(f, L"%ls %lu\n", state, (unsigned long)error_code);
    fclose(f);
}


static void spawn_cli(const WCHAR *cmd)
{
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    WCHAR buf[2048];
    wcsncpy(buf, cmd, 2047);
    buf[2047] = 0;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    if (CreateProcessW(NULL, buf, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                       NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    } else {
    }
}

static void spawn_paste(HWND fg)
{
    WCHAR cmd[2048];
    _snwprintf(cmd, 2048,
               L"\"%ls\" -X utf8 \"%ls\" paste-window %llu --gui --on-conflict %ls",
               g_pythonw, g_cli, (unsigned long long)(UINT_PTR)fg, g_conflict);
    spawn_cli(cmd);
}

static void spawn_copy(HWND fg, BOOL move)
{
    WCHAR cmd[2048];
    _snwprintf(cmd, 2048,
               L"\"%ls\" -X utf8 \"%ls\" copy-selection %llu %ls",
               g_pythonw, g_cli, (unsigned long long)(UINT_PTR)fg,
               move ? L"--cut" : L"");
    spawn_cli(cmd);
}

static void spawn_delete(HWND fg, BOOL permanent)
{
    WCHAR cmd[2048];
    _snwprintf(cmd, 2048,
               L"\"%ls\" -X utf8 \"%ls\" delete-selection %llu %ls --gui",
               g_pythonw, g_cli, (unsigned long long)(UINT_PTR)fg,
               permanent ? L"--permanent" : L"--recycle");
    spawn_cli(cmd);
}

/* 原生按钮矩形缓存，每 150ms 重读 PowerShell 扫描写的文件；
   每行 kind\towner_hwnd\tx\ty\twidth\theight（UTF-8 无 BOM，纯 ASCII 与制表符）。 */

/* 用裸 Win32 CreateFileW/ReadFile 读，不用 CRT 的 _wfopen/fgetws：PowerShell 侧
   每 ~120ms 用 Move-Item -Force 原地替换文件，_wfopen 不带 FILE_SHARE_DELETE，
   并发几秒后必现 0xC0000005 崩掉整个 hook_agent.exe（键盘钩子也一起死）。
   显式带 FILE_SHARE_DELETE 消除竞争，而不是读失败就跳过。 */
static void reload_rects(void)
{
    HotRect tmp[MAX_RECTS];
    int n = 0;

    HANDLE fh = CreateFileW(g_rects_path, GENERIC_READ,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (fh == INVALID_HANDLE_VALUE) {
        EnterCriticalSection(&g_rects_cs);
        g_rect_count = 0;
        LeaveCriticalSection(&g_rects_cs);
        return;
    }

    static char buf[16384];
    DWORD got = 0;
    BOOL ok = ReadFile(fh, buf, sizeof(buf) - 1, &got, NULL);
    CloseHandle(fh);
    if (!ok || got == 0) {
        EnterCriticalSection(&g_rects_cs);
        g_rect_count = 0;
        LeaveCriticalSection(&g_rects_cs);
        return;
    }
    buf[got] = '\0';

    static WCHAR wbuf[16384];
    int wlen = MultiByteToWideChar(CP_UTF8, 0, buf, (int)got, wbuf, 16383);
    if (wlen <= 0) {
        EnterCriticalSection(&g_rects_cs);
        g_rect_count = 0;
        LeaveCriticalSection(&g_rects_cs);
        return;
    }
    wbuf[wlen] = L'\0';

    WCHAR *p = wbuf;
    while (*p && n < MAX_RECTS) {
        WCHAR *eol = wcschr(p, L'\n');
        if (eol) *eol = L'\0';
        size_t len = wcslen(p);
        if (len > 0 && p[len - 1] == L'\r') p[len - 1] = L'\0';

        WCHAR kind[16];
        unsigned long long owner;
        long x, y, w, h;
        int matched = swscanf(p, L"%15[^\t]\t%llu\t%ld\t%ld\t%ld\t%ld",
                              kind, &owner, &x, &y, &w, &h);
        if (matched == 6) {
            tmp[n].is_paste = (wcscmp(kind, L"paste") == 0);
            tmp[n].owner = (HWND)(UINT_PTR)owner;
            tmp[n].r.left = x;
            tmp[n].r.top = y;
            tmp[n].r.right = x + w;
            tmp[n].r.bottom = y + h;
            n++;
        }

        if (!eol) break;
        p = eol + 1;
    }

    EnterCriticalSection(&g_rects_cs);
    memcpy(g_rects, tmp, sizeof(HotRect) * (size_t)n);
    g_rect_count = n;
    LeaveCriticalSection(&g_rects_cs);
}

static DWORD WINAPI reload_thread_proc(LPVOID unused)
{
    (void)unused;
    while (!g_reload_stop) {
        reload_rects();
        Sleep(RECT_RELOAD_MS);
    }
    return 0;
}

/* 命中后兜底校验：缓存矩形可能是几百毫秒前的，须确认 owner 窗口仍存活且类名
   仍是资源管理器，否则会误吞无关点击。 */
static BOOL find_hit(LONG x, LONG y, HotRect *out)
{
    BOOL found = FALSE;
    EnterCriticalSection(&g_rects_cs);
    for (int i = 0; i < g_rect_count; i++) {
        HotRect *r = &g_rects[i];
        if (x < r->r.left || x >= r->r.right || y < r->r.top || y >= r->r.bottom)
            continue;
        if (!IsWindow(r->owner)) continue;
        WCHAR cls[64] = L"";
        GetClassNameW(r->owner, cls, 64);
        if (!explorer_class_ok(cls)) continue;
        *out = *r;
        found = TRUE;
        break;
    }
    LeaveCriticalSection(&g_rects_cs);
    return found;
}

static void spawn_ui_scanner(void)
{
    WCHAR cmd[2048];
    _snwprintf(cmd, 2048,
               L"powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden "
               L"-ExecutionPolicy Bypass -File \"%ls\" -OutFile \"%ls\"",
               g_ps1path, g_rects_path);
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                       NULL, NULL, &si, &pi)) {
        g_scanner_proc = pi.hProcess;
        CloseHandle(pi.hThread);
    }
}

/* 鼠标钩子只做矩形命中判断，路径上不出现 UIA/COM 调用。命中吞掉 DOWN，并记住
   也要吞下一次 UP（否则控件会收到无配对 DOWN 的 UP）。不过滤 LLMHF_INJECTED：
   本进程从不用 SendInput 触发自己，无死循环风险，且便于自动化验证。 */

static BOOL g_swallow_next_up = FALSE;

static LRESULT CALLBACK mouse_proc(int code, WPARAM wparam, LPARAM lparam)
{
    if (code == HC_ACTION) {
        const MSLLHOOKSTRUCT *m = (const MSLLHOOKSTRUCT *)lparam;
        if (wparam == WM_LBUTTONUP && g_swallow_next_up) {
            g_swallow_next_up = FALSE;
            return 1;
        }
        if (wparam == WM_LBUTTONDOWN) {
            HotRect hit;
            if (find_hit(m->pt.x, m->pt.y, &hit)) {
                g_swallow_next_up = TRUE;
                if (hit.is_paste) {
                    log_line(L"PASTE_SWALLOWED owner=%llu x=%ld y=%ld",
                             (unsigned long long)(UINT_PTR)hit.owner, m->pt.x, m->pt.y);
                    spawn_paste(hit.owner);
                } else {
                    BOOL permanent = key_down(VK_SHIFT);
                    log_line(L"DELETE_SWALLOWED owner=%llu permanent=%d x=%ld y=%ld",
                             (unsigned long long)(UINT_PTR)hit.owner, permanent, m->pt.x, m->pt.y);
                    spawn_delete(hit.owner, permanent);
                }
                return 1;
            }
        }
    }
    return CallNextHookEx(NULL, code, wparam, lparam);
}

static LRESULT CALLBACK kb_proc(int code, WPARAM wparam, LPARAM lparam)
{
    if (code == HC_ACTION && (wparam == WM_KEYDOWN || wparam == WM_SYSKEYDOWN)) {
        const KBDLLHOOKSTRUCT *k = (const KBDLLHOOKSTRUCT *)lparam;
        if (binding_matches(&g_bind_copy, k) || binding_matches(&g_bind_cut, k)) {
            HWND fg = GetForegroundWindow();
            WCHAR cls[64] = L"";
            if (fg) {
                GetClassNameW(fg, cls, 64);
                if (fg_class_ok(cls) && focus_class_ok(fg)) {
                    spawn_copy(fg, binding_matches(&g_bind_cut, k));
                    return 1; /* 文件剪贴板由我们的入口写入 */
                }
            }
        }
        if (binding_matches(&g_bind_paste, k) &&
            IsClipboardFormatAvailable(CF_HDROP)) {
            HWND fg = GetForegroundWindow();
            WCHAR cls[64] = L"";
            if (fg) {
                GetClassNameW(fg, cls, 64);
                if (fg_class_ok(cls) && focus_class_ok(fg)) {
                    spawn_paste(fg);
                    return 1; /* 吞掉这次粘贴组合键，由我们的引擎粘贴 */
                }
            }
        }
        /* 删除/彻底删除：只在资源管理器文件列表区接管（桌面走系统）。
           两条绑定各自精确匹配修饰键，默认值下等价于旧版 Delete / Shift+Delete。 */
        if (binding_matches(&g_bind_del_permanent, k) ||
            binding_matches(&g_bind_del_recycle, k)) {
            HWND fg = GetForegroundWindow();
            WCHAR cls[64] = L"";
            if (fg) {
                GetClassNameW(fg, cls, 64);
                if (explorer_class_ok(cls) && focus_class_ok(fg)) {
                    spawn_delete(fg, binding_matches(&g_bind_del_permanent, k));
                    return 1; /* 吞掉，由我们的引擎删除 */
                }
            }
        }
    }
    return CallNextHookEx(NULL, code, wparam, lparam);
}

/* 不使用 swscanf 解析快捷键配置。MinGW 的宽字符 swscanf 在实际用户会话中会访问
   违规，因此在安装全局钩子前崩溃；这里用 wcstol 做显式、受边界保护的解析。 */
static BOOL parse_binding_int(const WCHAR **cursor, int *value)
{
    const WCHAR *p = *cursor;
    WCHAR *end;
    long parsed;

    while (*p == L' ' || *p == L'\t')
        ++p;
    parsed = wcstol(p, &end, 10);
    if (end == p || parsed < -2147483647L || parsed > 2147483647L)
        return FALSE;
    *value = (int)parsed;
    *cursor = end;
    return TRUE;
}

static BOOL parse_shortcut_binding(const WCHAR *line, WCHAR *name, size_t name_chars,
                                   int *vk, int *ctrl, int *alt, int *shift)
{
    const WCHAR *p = line;
    const WCHAR *start;
    size_t length;

    while (*p == L' ' || *p == L'\t')
        ++p;
    start = p;
    while (*p && *p != L' ' && *p != L'\t' && *p != L'\r' && *p != L'\n')
        ++p;
    length = (size_t)(p - start);
    if (length == 0 || length >= name_chars)
        return FALSE;
    wmemcpy(name, start, length);
    name[length] = L'\0';

    return parse_binding_int(&p, vk)
        && parse_binding_int(&p, ctrl)
        && parse_binding_int(&p, alt)
        && parse_binding_int(&p, shift);
}

/* 启动时读一次自定义键位（%TEMP%\file_clip_shortcuts.txt，设置页保存时 Python 侧原子
   替换并重启本代理）。仅装钩子前调用，无并发；缺文件/坏行保持内置默认。 */
static void load_shortcut_bindings(void)
{
    WCHAR tmpdir[MAX_PATH], path[MAX_PATH];
    WCHAR line[128], name[32];
    int vk, ctrl, alt, shift;
    FILE *f;
    GetTempPathW(MAX_PATH, tmpdir);
    _snwprintf(path, MAX_PATH, L"%lsfile_clip_shortcuts.txt", tmpdir);
    f = _wfopen(path, L"r");
    if (!f)
        return;
    while (fgetws(line, 128, f)) {
        if (!parse_shortcut_binding(line, name, 32, &vk, &ctrl, &alt, &shift))
            continue;
        if (vk < 1 || vk > 254)
            continue;
        {
            KeyBinding b;
            b.vk = vk;
            b.ctrl = ctrl ? TRUE : FALSE;
            b.alt = alt ? TRUE : FALSE;
            b.shift = shift ? TRUE : FALSE;
            if (wcscmp(name, L"paste") == 0)
                g_bind_paste = b;
            else if (wcscmp(name, L"copy") == 0)
                g_bind_copy = b;
            else if (wcscmp(name, L"cut") == 0)
                g_bind_cut = b;
            else if (wcscmp(name, L"delete_recycle") == 0)
                g_bind_del_recycle = b;
            else if (wcscmp(name, L"delete_permanent") == 0)
                g_bind_del_permanent = b;
        }
    }
    fclose(f);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmdline, int show)
{
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    HANDLE mutex, stop_event;
    (void)inst; (void)prev; (void)cmdline; (void)show;

    if (argc >= 2 && wcscmp(argv[1], L"--stop") == 0) {
        HANDLE ev = OpenEventW(EVENT_MODIFY_STATE, FALSE, STOP_EVENT_NAME);
        if (ev) { SetEvent(ev); CloseHandle(ev); return 0; }
        return 1; /* 没有实例在运行 */
    }
    if (argc >= 2 && wcscmp(argv[1], L"--status") == 0) {
        HANDLE existing = OpenMutexW(SYNCHRONIZE, FALSE, MUTEX_NAME);
        if (existing) { CloseHandle(existing); return 0; }
        return 1;
    }
    if (argc < 3)
        return 2; /* 缺 pythonw / cli 路径 */
    wcsncpy(g_pythonw, argv[1], MAX_PATH - 1);
    wcsncpy(g_cli, argv[2], MAX_PATH - 1);
    if (argc >= 4)
        wcsncpy(g_conflict, argv[3], 15);
    if (argc >= 5)
        wcsncpy(g_ps1path, argv[4], MAX_PATH - 1);
    if (argc >= 6)
        wcsncpy(g_status_path, argv[5], MAX_PATH - 1);
    if (!g_status_path[0])
        init_status_path();

    mutex = CreateMutexW(NULL, TRUE, MUTEX_NAME);
    if (GetLastError() == ERROR_ALREADY_EXISTS)
        return 0; /* 已有实例，静默退出 */

    load_shortcut_bindings(); /* 自定义键位（没有配置文件就用内置默认） */
    stop_event = CreateEventW(NULL, TRUE, FALSE, STOP_EVENT_NAME);
    if (!stop_event) {
        DWORD error_code = GetLastError();
        write_status(L"failed", error_code);
        CloseHandle(mutex);
        return 3;
    }
    g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, kb_proc, GetModuleHandleW(NULL), 0);
    if (!g_hook) {
        DWORD error_code = GetLastError();
        write_status(L"failed", error_code);
        CloseHandle(stop_event);
        CloseHandle(mutex);
        return 3;
    }
    write_status(L"running", 0);

    /* 原生按钮接管：给了 UIA 脚本路径且文件确实存在才启用，否则纯键盘版，零影响 */
    if (g_ps1path[0] && GetFileAttributesW(g_ps1path) != INVALID_FILE_ATTRIBUTES) {
        WCHAR tmpdir[MAX_PATH];
        GetTempPathW(MAX_PATH, tmpdir);
        _snwprintf(g_rects_path, MAX_PATH, L"%lsfile_clip_hotrects.txt", tmpdir);
        _snwprintf(g_log_path, MAX_PATH, L"%lsfile_clip_mouse_hook.log", tmpdir);
        InitializeCriticalSection(&g_rects_cs);
        spawn_ui_scanner();
        g_reload_thread = CreateThread(NULL, 0, reload_thread_proc, NULL, 0, NULL);
        g_mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, mouse_proc, GetModuleHandleW(NULL), 0);
        g_mouse_enabled = (g_mouse_hook != NULL);
    }

    for (;;) {
        DWORD wait = MsgWaitForMultipleObjects(1, &stop_event, FALSE, INFINITE,
                                               QS_ALLINPUT);
        if (wait == WAIT_OBJECT_0)
            break; /* --stop 信号 */
        MSG msg;
        while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT)
                goto done;
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
done:
    if (g_mouse_hook) UnhookWindowsHookEx(g_mouse_hook);
    if (g_mouse_enabled) {
        g_reload_stop = 1;
        if (g_reload_thread) {
            WaitForSingleObject(g_reload_thread, 1000);
            CloseHandle(g_reload_thread);
        }
        if (g_scanner_proc) {
            TerminateProcess(g_scanner_proc, 0);
            CloseHandle(g_scanner_proc);
        }
        DeleteCriticalSection(&g_rects_cs);
    }
    UnhookWindowsHookEx(g_hook);
    write_status(L"stopped", 0);
    CloseHandle(stop_event);
    CloseHandle(mutex);
    return 0;
}
