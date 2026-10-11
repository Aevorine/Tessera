// tessera-rendezvous 是「汇合点」服务：帮不在同一局域网的设备互相找到对方，直连不通时转发已加密的字
// 节。
//
// 它看得到：每 30 分钟变一次的暗号和双方 IP:端口；看不到任何内容（转发的是密文，不持有密钥）。
// 不落盘、不记谁跟谁通信，重启即忘。
//
// 运行：go build ./cmd/tessera-rendezvous && ./tessera-rendezvous -addr :47820 -secret <口令>，
// 两台设备填同一汇合点地址和口令；服务器需有两台设备都能访问的地址。
//
// 注意 47820 是 UDP（底下是 QUIC）：安全组、防火墙、端口映射三处都要放行 UDP，只放 TCP 会连不上且不
// 报错。
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/Aevorine/Tessera/crossdevice/core/rendezvous"
)

func main() {
	addr := flag.String("addr", ":47820", "监听地址（UDP）")
	secret := flag.String("secret", "", "服务器口令。填了之后只有知道它的设备能用这台服务器；留空则任何知道暗号的设备都能用")
	noRelay := flag.Bool("no-relay", false, "只做地址交换，不提供中继转发（省带宽，但打不通的设备就连不上了）")
	quotaGB := flag.Int64("quota-gb", 2, "每个暗号每天的中继流量上限（GB）")
	quotaIPGB := flag.Int64("quota-ip-gb", 8, "每个来源地址（IPv6 按 /64）每天的中继流量上限（GB）")
	maxPerIP := flag.Int("max-relays-per-ip", 16, "每个来源地址同时进行的中继流上限")
	maxRelays := flag.Int("max-relays", 1024, "整台服务器同时进行的中继流上限")
	flag.Parse()

	logger := log.New(os.Stdout, "", log.LstdFlags)

	if *secret == "" && !*noRelay {
		logger.Println("[提醒] 没有设置 -secret：任何知道暗号的设备都能用这台服务器中继。" +
			"个人使用建议加上 -secret，一串自己编的字符串即可。")
	}

	srv := rendezvous.NewServer(rendezvous.ServerConfig{
		Addr:                 *addr,
		Secret:               *secret,
		DisableRelay:         *noRelay,
		DailyRelayBytes:      *quotaGB << 30,
		DailyRelayBytesPerIP: *quotaIPGB << 30,
		MaxRelaysPerIP:       *maxPerIP,
		MaxRelays:            *maxRelays,
		Logger:               logger,
	})
	if err := srv.Start(); err != nil {
		logger.Fatalf("启动失败: %v", err)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	logger.Println("正在停止…")
	_ = srv.Close()
}
