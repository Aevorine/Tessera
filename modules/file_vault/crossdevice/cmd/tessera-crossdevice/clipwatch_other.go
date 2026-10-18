//go:build !windows

package main

// 非 Windows 平台没有事件源，Electron 侧照旧轮询。
func watchClipboard(func(seq uint32)) bool { return false }
