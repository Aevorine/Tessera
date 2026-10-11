package transfer

import (
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// 路径安全是文件接收侧最易出严重漏洞处：manifest 里塞 "../../../../Windows/System32/x.dll"
// 就能让接收端写任意位置。下面的检查一条都不能省。设计见 docs/01-架构与技术原理.md §10.4。

var (
	ErrPathEscape   = errors.New("路径逃逸：相对路径试图跳出目标目录")
	ErrPathAbsolute = errors.New("路径非法：不接受绝对路径")
	ErrPathEmpty    = errors.New("路径为空")
	ErrPathNul      = errors.New("路径含 NUL 字节")
	ErrPathTooLong  = errors.New("路径过长")
	ErrPathControl  = errors.New("路径含控制字符")
)

const maxRelPathLen = 1024

// Windows 保留设备名。写入名为 CON、NUL、COM1 的文件在 Windows 上会
// 被重定向到设备而不是文件，行为诡异且可被用来做拒绝服务。
var windowsReserved = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// Windows 文件名非法字符。
const windowsIllegal = `<>:"|?*\`

// SanitizeRelPath 清洗 manifest 里的相对路径，返回安全的斜杠分隔路径。必须先做 Unicode
// 规范化再检查，否则攻击者可用组合字符构造规范化后才变成 ".." 的路径来绕过。
func SanitizeRelPath(rel string) (string, error) {
	if rel == "" {
		return "", ErrPathEmpty
	}
	if len(rel) > maxRelPathLen {
		return "", ErrPathTooLong
	}
	if strings.ContainsRune(rel, 0) {
		return "", ErrPathNul
	}
	for _, r := range rel {
		if unicode.IsControl(r) {
			return "", ErrPathControl
		}
	}

	rel = norm.NFC.String(rel)
	// 反斜杠在 Windows 上是分隔符，在 Linux 上是合法文件名字符。
	// 统一当作分隔符处理，避免跨平台不一致造成的绕过。
	rel = strings.ReplaceAll(rel, `\`, "/")

	if strings.HasPrefix(rel, "/") {
		return "", ErrPathAbsolute
	}
	// Windows 盘符（C:\...）和 UNC（//server/share）。
	if len(rel) >= 2 && rel[1] == ':' {
		return "", ErrPathAbsolute
	}
	if strings.HasPrefix(rel, "//") {
		return "", ErrPathAbsolute
	}

	cleaned := path.Clean(rel)
	if cleaned == "." || cleaned == "/" {
		return "", ErrPathEmpty
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", ErrPathEscape
	}

	parts := strings.Split(cleaned, "/")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" || p == "." {
			continue
		}
		if p == ".." {
			return "", ErrPathEscape
		}
		out = append(out, sanitizeComponent(p))
	}
	if len(out) == 0 {
		return "", ErrPathEmpty
	}
	return strings.Join(out, "/"), nil
}

// sanitizeComponent 清洗单个路径分量，使其在三个平台上都合法。
func sanitizeComponent(p string) string {
	var b strings.Builder
	for _, r := range p {
		if strings.ContainsRune(windowsIllegal, r) {
			b.WriteRune('_')
			continue
		}
		b.WriteRune(r)
	}
	s := b.String()

	// Windows 上尾部的点和空格会被静默去掉（"a." → "a"），
	// 这会造成 manifest 里两个不同名的文件落地后同名互相覆盖。主动改名避免。
	trimmed := strings.TrimRight(s, ". ")
	if trimmed == "" {
		trimmed = "_"
	}
	if trimmed != s {
		s = trimmed + "_"
	}

	// 保留设备名（含带扩展名的 CON.txt）都要改。
	base := s
	if i := strings.IndexByte(s, '.'); i > 0 {
		base = s[:i]
	}
	if windowsReserved[strings.ToUpper(base)] {
		s = "_" + s
	}
	return s
}

// ResolveDest 把清洗后的相对路径拼到目标目录并做最终越界校验。即使前面都通过也要再验落地
// 路径在目标目录内（纵深防御）：符号链接、大小写不敏感文件系统、平台路径解析都可能在
// Clean 之后仍逃逸。
func ResolveDest(destDir, rel string) (string, error) {
	safe, err := SanitizeRelPath(rel)
	if err != nil {
		return "", fmt.Errorf("%w (原始路径 %q)", err, rel)
	}
	absDest, err := filepath.Abs(destDir)
	if err != nil {
		return "", err
	}
	full := filepath.Join(absDest, filepath.FromSlash(safe))

	// 用带分隔符的前缀比较，防止 "/data/out" 匹配到 "/data/output-evil"。
	prefix := absDest + string(filepath.Separator)
	if !strings.HasPrefix(full, prefix) {
		return "", fmt.Errorf("%w: %q", ErrPathEscape, rel)
	}
	return full, nil
}
