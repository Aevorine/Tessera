//go:build windows

package main

import (
	"runtime"
	"syscall"
	"unsafe"
)

// 剪贴板变化监听：消息专用窗口 + AddClipboardFormatListener，系统在每次复制后立即投递
// WM_CLIPBOARDUPDATE。事件驱动，空闲零开销，不打开剪贴板，不和别的程序抢锁。
// 只负责「变了」这个信号，读内容仍由 Electron 做（多格式读取在那边是现成的）。

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procRegisterClassExW           = user32.NewProc("RegisterClassExW")
	procCreateWindowExW            = user32.NewProc("CreateWindowExW")
	procDefWindowProcW             = user32.NewProc("DefWindowProcW")
	procGetMessageW                = user32.NewProc("GetMessageW")
	procDispatchMessageW           = user32.NewProc("DispatchMessageW")
	procAddClipboardFormatListener = user32.NewProc("AddClipboardFormatListener")
	procGetClipboardSequenceNumber = user32.NewProc("GetClipboardSequenceNumber")
	procGetModuleHandleW           = kernel32.NewProc("GetModuleHandleW")
)

const wmClipboardUpdate = 0x031D

// hwndMessage 即 HWND_MESSAGE（-3）。
var hwndMessage = ^uintptr(2)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
	Private uint32
}

// watchClipboard 起监听线程；建不起来返回 false（Electron 侧继续用轮询兜底）。
// onChange 在监听线程上调用，参数是剪贴板序号，同一序号只报一次。
func watchClipboard(onChange func(seq uint32)) bool {
	ready := make(chan bool, 1)
	go func() {
		// 窗口和消息循环必须在同一个系统线程上。
		runtime.LockOSThread()
		var last uint32
		proc := syscall.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
			if uint32(msg) == wmClipboardUpdate {
				seq, _, _ := procGetClipboardSequenceNumber.Call()
				if s := uint32(seq); s != last {
					last = s
					onChange(s)
				}
				return 0
			}
			r, _, _ := procDefWindowProcW.Call(hwnd, msg, wp, lp)
			return r
		})
		inst, _, _ := procGetModuleHandleW.Call(0)
		name, _ := syscall.UTF16PtrFromString("TesseraClipWatch")
		wc := wndClassEx{WndProc: proc, Instance: inst, ClassName: name}
		wc.Size = uint32(unsafe.Sizeof(wc))
		if r, _, _ := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
			ready <- false
			return
		}
		hwnd, _, _ := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(name)), 0, 0, 0, 0, 0, 0, hwndMessage, 0, inst, 0)
		if hwnd == 0 {
			ready <- false
			return
		}
		if r, _, _ := procAddClipboardFormatListener.Call(hwnd); r == 0 {
			ready <- false
			return
		}
		seq, _, _ := procGetClipboardSequenceNumber.Call()
		last = uint32(seq)
		ready <- true
		var m winMsg
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(r) <= 0 {
				return
			}
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}()
	return <-ready
}
