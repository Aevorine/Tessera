//go:build windows

package transfer

import "os"

// markFromOtherDevice 写 Mark-of-the-Web（NTFS 备用数据流 Zone.Identifier，ZoneId=3 = Internet），
// 与浏览器下载的文件同等对待。FAT/exFAT 等不支持备用数据流的盘上写不了，忽略即可。
func markFromOtherDevice(path string) {
	_ = os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0o644)
}
