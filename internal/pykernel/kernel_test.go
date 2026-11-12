package pykernel

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func startTest(t *testing.T) *Kernel {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	t.Setenv("DBX_KERNEL_TEST", "1")
	k, err := Start(context.Background(), Config{Python: py, DriverPath: filepath.Join(t.TempDir(), "driver.py")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(k.Close)
	return k
}

func run(t *testing.T, k *Kernel, code string) (out struct {
	Status, Kind, Text, Error, Detail string
}) {
	t.Helper()
	o, err := k.Run(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	out.Status, out.Kind, out.Text, out.Error, out.Detail = o.Status, o.Kind, o.Text, o.Error, o.Detail
	return out
}

func TestKernelKeepsState(t *testing.T) {
	k := startTest(t)
	if o := run(t, k, "x = 41"); o.Status != "finished" || o.Kind != "none" {
		t.Fatalf("%+v", o)
	}
	if o := run(t, k, "print('hi')\nx + 1"); o.Text != "hi\n42" || o.Kind != "text" {
		t.Fatalf("%+v", o)
	}
	if o := run(t, k, "None"); o.Kind != "none" {
		t.Fatalf("a None result shows nothing: %+v", o)
	}
}

func TestKernelErrors(t *testing.T) {
	k := startTest(t)
	o := run(t, k, "def f():\n    return 1 / 0\nf()")
	if o.Status != "error" || o.Error != "ZeroDivisionError: division by zero" {
		t.Fatalf("%+v", o)
	}
	if !strings.Contains(o.Detail, "return 1 / 0") || strings.Contains(o.Detail, "driver.py") {
		t.Fatalf("traceback should show the cell, not the driver:\n%s", o.Detail)
	}
	if o := run(t, k, "def ("); o.Status != "error" || !strings.HasPrefix(o.Error, "SyntaxError") {
		t.Fatalf("%+v", o)
	}
	// The session survives errors.
	if o := run(t, k, "1 + 1"); o.Text != "2" {
		t.Fatalf("%+v", o)
	}
}

func TestKernelCancel(t *testing.T) {
	k := startTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()
	o, err := k.Run(ctx, "import time\nfor _ in range(600):\n    time.sleep(0.05)")
	if err != nil || o.Status != "cancelled" {
		t.Fatalf("%+v %v", o, err)
	}
	if o := run(t, k, "'still here'"); o.Text != "'still here'" {
		t.Fatalf("%+v", o)
	}
}

func TestKernelExitIsGone(t *testing.T) {
	k := startTest(t)
	_, err := k.Run(context.Background(), "import os\nos._exit(3)")
	if !errors.Is(err, ErrGone) || k.Alive() {
		t.Fatalf("got %v", err)
	}
}

func TestKernelPandasTable(t *testing.T) {
	k := startTest(t)
	if o := run(t, k, "import pandas"); o.Status != "finished" {
		t.Skip("pandas is not installed")
	}
	o, err := k.Run(context.Background(), "import pandas as pd\npd.DataFrame({'a': [1, None], 'b': ['x', 'y']})")
	if err != nil || o.Kind != "table" || len(o.Rows) != 2 || len(o.Columns) != 2 {
		t.Fatalf("%+v %v", o, err)
	}
	if o.Rows[1][0] != nil || *o.Rows[0][1] != "x" {
		t.Fatalf("rows %v", o.Rows)
	}
}

func TestPoolRestartsLostSession(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	t.Setenv("DBX_KERNEL_TEST", "1")
	dir := t.TempDir()
	start := func(ctx context.Context) (*Kernel, error) {
		return Start(ctx, Config{Python: py, DriverPath: filepath.Join(dir, "driver.py")})
	}
	p := NewPool()
	defer p.EndAll(context.Background())
	ctx := context.Background()
	if _, info, err := p.Run(ctx, "nb", "a", start, "x = 1"); err != nil || !info.Started {
		t.Fatalf("%+v %v", info, err)
	}
	if !p.Active("nb") {
		t.Fatal("session should be active")
	}
	if _, info, _ := p.Run(ctx, "nb", "a", start, "x"); info.Started {
		t.Fatal("second run should reuse the session")
	}
	p.Run(ctx, "nb", "a", start, "import os\nos._exit(1)")
	out, info, err := p.Run(ctx, "nb", "a", start, "x")
	if err != nil || !info.Started || out.Status != "error" {
		t.Fatalf("after a crash x is undefined in a new session: %+v %+v %v", out, info, err)
	}
	if _, info, _ := p.Run(ctx, "nb", "b", start, "1"); !info.Started || info.Lost {
		t.Fatalf("a new spec starts a session without reporting it lost: %+v", info)
	}
	p.End(ctx, "nb")
	if p.Active("nb") {
		t.Fatal("End should stop the session")
	}
}

func TestKernelErrorMessageOnNextLine(t *testing.T) {
	k := startTest(t)
	o := run(t, k, "class ParseException(Exception):\n    pass\nraise ParseException('\\n[PARSE_SYNTAX_ERROR] Syntax error')")
	if o.Error != "ParseException: [PARSE_SYNTAX_ERROR] Syntax error" {
		t.Fatalf("%q", o.Error)
	}
}

func TestKernelCancelBlockingCall(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows interrupts at the next Python instruction")
	}
	k := startTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	o, err := k.Run(ctx, "import time\ntime.sleep(30)")
	if err != nil || o.Status != "cancelled" || time.Since(start) > 5*time.Second {
		t.Fatalf("%+v %v after %s", o, err, time.Since(start))
	}
	if !k.Alive() {
		t.Fatal("the session should survive a cancel")
	}
}
