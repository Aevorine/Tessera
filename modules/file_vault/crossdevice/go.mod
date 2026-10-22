module github.com/Aevorine/Tessera/crossdevice

go 1.26.1

// 最低 1.26.10（1.27 系列要 1.27.3）：govulncheck 实测这个模块**可达**三个标准库漏洞，
// 都在 QUIC/TLS 这条直接暴露在网络上的路径上，这两个版本才全部修掉。
// 发布用的二进制按 1.27 系列构建，所以这里钉 1.27.3；用 1.27.0 / 1.27.1 编出来的包带着 GO-2026-6607。
//   GO-2026-6090 crypto/tls    握手后消息不限量 -> transport.Endpoint.Dial 可达
//   GO-2026-5972 encoding/asn1 递归深度不设限 -> transport.Open 可达
//   GO-2026-6607 crypto/tls    ECH 外层扩展引用不校验 -> transport.Endpoint.Dial 可达
//   GO-2026-6809 crypto/x509 证书信任撤销校验 -> Certificate.Verify 可达
// 写 toolchain 而不是抬高上面那行 go 指令：go 指令是「源码用到哪一版的语言
// 特性」，toolchain 是「用哪一版的编译器和标准库构建」。这里要修的是标准库，
// 所以该动的是后者。
toolchain go1.27.3

require (
	github.com/flynn/noise v1.1.0
	github.com/fxamacker/cbor/v2 v2.9.2
	github.com/grandcat/zeroconf v1.0.0
	github.com/quic-go/quic-go v0.61.0
	golang.org/x/crypto v0.56.0
	golang.org/x/text v0.41.0
	lukechampine.com/blake3 v1.4.1
)

require (
	github.com/cenkalti/backoff v2.2.1+incompatible // indirect
	github.com/klauspost/cpuid/v2 v2.0.9 // indirect
	github.com/miekg/dns v1.1.27 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	golang.org/x/mobile v0.0.0-20260709172247-6129f5bee9d5 // indirect
	golang.org/x/mod v0.38.0 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/tools v0.48.0 // indirect
)

tool golang.org/x/mobile/cmd/gobind

// grandcat/zeroconf v1.0.0 带一处竞态修复（Shutdown 与接收协程的 WaitGroup 顺序），
// 上游已不维护。改动见 third_party/zeroconf/PATCHES.md。
replace github.com/grandcat/zeroconf => ./third_party/zeroconf
