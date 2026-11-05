//go:build !windows

package transfer

// markFromOtherDevice 只有 Windows 有 Mark-of-the-Web；安卓端落地后交给系统文件选择器处理。
func markFromOtherDevice(string) {}
