// tessera-crossdevice 是 Tessera 在 Windows 上的跨设备同步守护进程，由 Electron 主进程作为 sidecar
// 拉起，
// 在 stdio 上用行分隔 JSON 通信；本文件只把 stdio 接到 core/agent（协议逻辑在其中，与 Android 共用
// ）。
// 分工：Go 只管协议（身份、配对、加密、传输、重连），不读写系统剪贴板，只上报「剪贴板变了」；Electron
// 管平台（剪贴板、安全码弹窗、选文件）。
// 这样切是因为 Electron 里读写多格式剪贴板是现成 API，而 Go 调 Win32 要自己转 CF_DIB/CF_HTML。
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"sync"

	"github.com/Aevorine/Tessera/crossdevice/core/agent"
)

func main() {
	var (
		dataDir = flag.String("data", "", "数据目录（必填）")
		name    = flag.String("name", "", "本机设备名")
		addr    = flag.String("listen", ":39421", "监听地址")
	)
	flag.Parse()

	// 日志走 stderr：stdout 是协议通道，往里写一个字节都会让对面解析失败。
	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	if *dataDir == "" {
		fmt.Fprintln(os.Stderr, "必须指定 -data")
		os.Exit(2)
	}
	if err := run(*dataDir, *name, *addr); err != nil {
		log.Printf("退出: %v", err)
		os.Exit(1)
	}
}

func run(dataDir, name, addr string) error {
	out := bufio.NewWriter(os.Stdout)
	var outMu sync.Mutex
	sink := func(line string) {
		outMu.Lock()
		defer outMu.Unlock()
		out.WriteString(line)
		out.WriteByte('\n')
		// 每条都 flush：这是交互式通道，攒着不发会让 UI 看起来卡住。
		out.Flush()
	}

	a, err := agent.New(agent.Config{
		DataDir: dataDir,
		Name:    name,
		Addr:    addr,
		Sink:    sink,
	})
	if err != nil {
		return err
	}
	defer a.Close()

	// 剪贴板一变就通知 Electron 去读，替代它的高频轮询。
	if watchClipboard(func(seq uint32) {
		sink(fmt.Sprintf(`{"event":"clip_changed","data":{"seq":%d}}`, seq))
	}) {
		sink(`{"event":"clip_watch","data":{"ok":true}}`)
	}

	sc := bufio.NewScanner(os.Stdin)
	// 单条请求可能带着 base64 的图片，默认 64KB 缓冲远远不够。
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		a.Handle(sc.Text())
	}
	if err := sc.Err(); err != nil && err != io.EOF {
		return err
	}
	return nil
}
