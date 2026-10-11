// Package mobile is the gomobile binding layer for the Android client.
//
// It contains NO protocol logic (all in core/agent); it only reshapes the API into gomobile-friendly
// types, so the surface is "a JSON string in, JSON strings out".
//
// IMPORTANT: keep every comment in this file ASCII-only. gobind copies doc comments into
// Mobile.java and javac reads it in the platform charset (GBK), giving confusing "unmappable
// character" build errors. Chinese notes belong in core/agent and docs/.
//
// Kotlin usage:
//
//	val agent = Mobile.newAgent(dataDir, deviceName, "", object : EventSink {
//	    override fun onLine(line: String) { /* parse JSON, post to UI */ }
//	})
//	agent.handle("""{"id":1,"method":"status"}""")
//
// Building the .aar:
//
//	gomobile bind -target=android/arm64,android/amd64 -androidapi 26 \
//	  -o android/app/libs/tesseracore.aar \
//	  github.com/Aevorine/Tessera/crossdevice/mobile
package mobile

import (
	"encoding/json"
	"fmt"

	"github.com/Aevorine/Tessera/crossdevice/core/agent"
	"github.com/Aevorine/Tessera/crossdevice/core/netif"
)

// SetNetworkInterfaces hands Go the local interface list. Do not remove as redundant.
//
// On Android 11+, net.Interfaces() always fails ("netlinkrib: permission denied", golang/go#40569),
// silently leaving LAN scan and mDNS with no interfaces. Java's NetworkInterface still works,
// so Kotlin enumerates and pushes them here.
//
// Call BEFORE NewAgent (discovery starts in the constructor) and again on network change.
// Argument: JSON array, e.g. [{"Index":12,"Name":"wlan0","Up":true,"Loopback":false,
// "Multicast":true,"Addrs":["192.168.1.7/24"]}]. An empty array means "none found" and
// suppresses the net.Interfaces() fallback.
func SetNetworkInterfaces(listJSON string) error {
	var list []netif.Iface
	if err := json.Unmarshal([]byte(listJSON), &list); err != nil {
		return fmt.Errorf("network interface list is not valid JSON: %w", err)
	}
	netif.SetProvided(list)
	return nil
}

// EventSink is implemented in Java/Kotlin and receives every response and event as one JSON line.
// Implementations MUST be thread-safe: callbacks come from several Go goroutines, not the main thread.
type EventSink interface {
	OnLine(line string)
}

// Agent is the binding-layer handle. It wraps agent.Agent because gomobile only exports types
// declared in the bound package; otherwise the .aar is empty.
type Agent struct {
	inner *agent.Agent
}

// NewAgent starts the cross-device node.
//
// dataDir must be app-private storage (context.filesDir); the long-term private key lives there.
// Pass an empty listenAddr to let the OS pick a port: a fixed port may clash with other apps,
// and pairing code and mDNS advertise the actual port anyway.
func NewAgent(dataDir, deviceName, listenAddr string, sink EventSink) (*Agent, error) {
	a, err := agent.New(agent.Config{
		DataDir: dataDir,
		Name:    deviceName,
		Addr:    listenAddr,
		Sink:    func(line string) { sink.OnLine(line) },
	})
	if err != nil {
		return nil, err
	}
	return &Agent{inner: a}, nil
}

// Handle feeds in one line of JSON request. Responses come back asynchronously
// through the EventSink.
func (a *Agent) Handle(line string) {
	a.inner.Handle(line)
}

// Close stops the node. Android callers should invoke this when the foreground
// service is destroyed.
func (a *Agent) Close() error {
	return a.inner.Close()
}
