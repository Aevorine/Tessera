package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func waitTransferKind(t *testing.T, events *eventLog, kind string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, line := range events.snapshot() {
			var e struct {
				Event string         `json:"event"`
				Data  map[string]any `json:"data"`
			}
			if json.Unmarshal([]byte(line), &e) == nil && e.Event == "transfer" && e.Data["kind"] == kind {
				return e.Data
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no transfer %s event", kind)
	return nil
}

func TestDelivery_NoSuccessBeforeVisibleSaveAndFailedSaveRecovers(t *testing.T) {
	visible := filepath.Join(t.TempDir(), "received.apk")
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	p := newE2EPair(t, func(path string) (string, error) {
		n := calls.Add(1)
		if n == 1 {
			close(entered)
			<-release
			return "", fmt.Errorf("receive folder permission revoked")
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(visible, b, 0600); err != nil {
			return "", err
		}
		return visible, nil
	})
	src := filepath.Join(t.TempDir(), "example.apk")
	writeRandom(t, src, 2_100_000)
	p.send(t, src)
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("delivery callback was not invoked")
	}
	for _, line := range p.hostEv.snapshot() {
		if bytes.Contains([]byte(line), []byte(`"kind":"done"`)) {
			t.Fatal("success before platform save")
		}
	}
	close(release)
	waitTransferKind(t, p.hostEv, "error")
	staged := filepath.Join(p.guest.downloadDir.Load().(string), "example.apk")
	if _, err := os.Stat(staged); err != nil {
		t.Fatal("failed save lost staged file:", err)
	}
	p.send(t, src)
	done := waitTransferKind(t, p.hostEv, "done")
	if done["skipped"] != true || done["saved_to"] != visible {
		t.Fatalf("missing recovered receipt: %v", done)
	}
	want, _ := os.ReadFile(src)
	got, err := os.ReadFile(visible)
	if err != nil || !bytes.Equal(want, got) {
		t.Fatal("visible file missing or corrupt:", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("delivery called %d times", calls.Load())
	}
}

// A repeat send must re-expose a staged file so interrupted platform delivery can recover.
func TestDelivery_ExistingFileIsSurfacedOnRepeatSend(t *testing.T) {
	p := newE2EPair(t)
	src := filepath.Join(t.TempDir(), "example.apk")
	writeRandom(t, src, 2_100_000)
	dest := filepath.Join(p.guest.downloadDir.Load().(string), "example.apk")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dest, b, 0600); err != nil {
		t.Fatal(err)
	}
	p.send(t, src)
	waitTransferKind(t, p.hostEv, "done")
	e := waitTransferKind(t, p.guestEv, "recv_done")
	if e["path"] != dest {
		t.Fatalf("wrong received path: %v", e["path"])
	}
}
