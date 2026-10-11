package transport

import (
	"context"
	"net"
	"strconv"
	"testing"
	"time"
)

// TestEndpointDialsFromListeningPort 是跨网能力的地基断言：从端点拨出的包，源端口必须就是
// 它监听的端口。破了的话局域网照常、测试全绿，唯独跨网静默失效——NAT 只放行"本机某端口
// 先发过东西"的回包，源端口一变回包被路由器丢掉且不报错。所以直接从接收端读 RemoteAddr
// 端口与发起端监听端口比对。
func TestEndpointDialsFromListeningPort(t *testing.T) {
	server, err := Open("127.0.0.1:0")
	if err != nil {
		t.Fatalf("开服务端端点失败: %v", err)
	}
	defer func() { _ = server.Close() }()

	client, err := Open("127.0.0.1:0")
	if err != nil {
		t.Fatalf("开客户端端点失败: %v", err)
	}
	defer func() { _ = client.Close() }()

	if client.Port() == 0 {
		t.Fatal("客户端端点没拿到监听端口")
	}

	type accepted struct {
		remote net.Addr
		err    error
	}
	got := make(chan accepted, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		conn, err := server.Accept(ctx)
		if err != nil {
			got <- accepted{err: err}
			return
		}
		got <- accepted{remote: conn.RemoteAddr()}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := client.Dial(ctx, server.Addr().String())
	if err != nil {
		t.Fatalf("拨号失败: %v", err)
	}
	defer func() { _ = conn.CloseWithError(0, "") }()

	select {
	case a := <-got:
		if a.err != nil {
			t.Fatalf("接受连接失败: %v", a.err)
		}
		_, portStr, err := net.SplitHostPort(a.remote.String())
		if err != nil {
			t.Fatalf("解析对端地址 %s 失败: %v", a.remote, err)
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			t.Fatalf("对端端口 %q 不是数字: %v", portStr, err)
		}
		if port != client.Port() {
			t.Fatalf("拨号用的源端口是 %d，但监听在 %d —— "+
				"监听与拨号没有共用同一个套接字，NAT 打洞必然失败（见 quic.go 头部说明）",
				port, client.Port())
		}
	case <-time.After(12 * time.Second):
		t.Fatal("服务端一直没接到连接")
	}
}

// TestEndpointAcceptsWhileDialing：同一端点须能边接受边拨出。打洞时双方同时互拨，
// 拨号期间收不了连接则互等超时，表现为难查的偶发失败。
func TestEndpointAcceptsWhileDialing(t *testing.T) {
	a, err := Open("127.0.0.1:0")
	if err != nil {
		t.Fatalf("开端点 A 失败: %v", err)
	}
	defer func() { _ = a.Close() }()
	b, err := Open("127.0.0.1:0")
	if err != nil {
		t.Fatalf("开端点 B 失败: %v", err)
	}
	defer func() { _ = b.Close() }()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	errs := make(chan error, 4)
	// 两边同时互拨，同时都在监听——这正是打洞时的现场。
	go func() { _, err := a.Dial(ctx, b.Addr().String()); errs <- err }()
	go func() { _, err := b.Dial(ctx, a.Addr().String()); errs <- err }()
	go func() { _, err := a.Accept(ctx); errs <- err }()
	go func() { _, err := b.Accept(ctx); errs <- err }()

	for i := 0; i < 4; i++ {
		select {
		case err := <-errs:
			if err != nil {
				t.Fatalf("同时互拨互收时第 %d 个操作失败: %v", i+1, err)
			}
		case <-ctx.Done():
			t.Fatalf("同时互拨互收超时，只完成了 %d/4 个操作", i)
		}
	}
}
