// Package pykernel runs notebook cells for serverless compute in a local
// Python process with Databricks Connect.
//
// Serverless compute has no public API for a remote, stateful Python session,
// so the app keeps the session on this computer: Python state and plain
// Python code live in a local process, while Spark and SQL operations run on
// serverless compute through Databricks Connect.
package pykernel

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"dbx-desktop/internal/nbexec"
)

//go:embed driver.py
var driverSource []byte

// maxLine bounds one reply, which can hold a 10,000-row table.
const maxLine = 256 << 20

var (
	// startWait is how long a new session may take to connect.
	startWait = 3 * time.Minute
	// cancelWait is how long a cancelled cell may take to stop before its
	// process is ended.
	cancelWait = 15 * time.Second
)

// ErrGone means the session's process has exited; its variables are lost.
var ErrGone = errors.New("the Python session has ended")

// Kernel is one running Python process for one notebook.
type Kernel struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan []byte
	exited chan struct{}
	tail   *tailBuffer
	nextID atomic.Int64
	wmu    sync.Mutex
	// stop is closed by Close so the reader never blocks on a reply nobody reads.
	stop      chan struct{}
	closeOnce sync.Once

	// Python and Connect are the versions the session reported.
	Python  string
	Connect string
}

// Config says how to start a session.
type Config struct {
	// Python is the interpreter of the environment with databricks-connect.
	Python string
	// DriverPath is where the driver script is written before starting.
	DriverPath string
	// Profile, ConfigFile and CLIPath let Databricks Connect authenticate
	// the same way the app does.
	Profile    string
	ConfigFile string
	CLIPath    string
}

// WriteDriver saves the driver script to path.
func WriteDriver(path string) error {
	if b, err := os.ReadFile(path); err == nil && string(b) == string(driverSource) {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, driverSource, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Start launches a session and waits until it has connected to serverless
// compute.
func Start(ctx context.Context, c Config) (*Kernel, error) {
	if err := WriteDriver(c.DriverPath); err != nil {
		return nil, fmt.Errorf("could not write the Python driver: %w", err)
	}
	cmd := exec.Command(c.Python, "-u", c.DriverPath)
	cmd.Env = append(os.Environ(),
		"DBX_PROFILE="+c.Profile,
		"PYTHONIOENCODING=utf-8",
		"PYTHONUNBUFFERED=1",
	)
	if c.ConfigFile != "" {
		cmd.Env = append(cmd.Env, "DATABRICKS_CONFIG_FILE="+c.ConfigFile)
	}
	if c.CLIPath != "" {
		cmd.Env = append(cmd.Env, "DATABRICKS_CLI_PATH="+c.CLIPath)
	}
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	k := &Kernel{
		cmd:    cmd,
		stdin:  stdin,
		lines:  make(chan []byte, 16),
		exited: make(chan struct{}),
		stop:   make(chan struct{}),
		tail:   &tailBuffer{max: 16 << 10},
	}
	cmd.Stderr = k.tail
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start Python: %w", err)
	}
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64<<10), maxLine)
		for sc.Scan() {
			select {
			case k.lines <- append([]byte(nil), sc.Bytes()...):
			case <-k.stop:
			}
		}
		_ = cmd.Wait()
		close(k.exited)
	}()

	timer := time.NewTimer(startWait)
	defer timer.Stop()
	for {
		select {
		case line := <-k.lines:
			var hello struct {
				Ready   *bool  `json:"ready"`
				Error   string `json:"error"`
				Detail  string `json:"detail"`
				Python  string `json:"python"`
				Connect string `json:"connect"`
			}
			if json.Unmarshal(line, &hello) != nil || hello.Ready == nil {
				continue
			}
			if !*hello.Ready {
				k.Close()
				return nil, &StartError{Summary: hello.Error, Detail: hello.Detail}
			}
			k.Python, k.Connect = hello.Python, hello.Connect
			return k, nil
		case <-k.exited:
			return nil, &StartError{Summary: "Python stopped while starting the session", Detail: k.tail.String()}
		case <-timer.C:
			k.Close()
			return nil, errors.New("connecting to serverless compute took too long")
		case <-ctx.Done():
			k.Close()
			return nil, ctx.Err()
		}
	}
}

// StartError is a session that could not connect, with Python's explanation.
type StartError struct {
	Summary string
	Detail  string
}

func (e *StartError) Error() string {
	s := strings.TrimSpace(e.Summary)
	if s == "" {
		s = lastLine(e.Detail)
	}
	return "could not start a serverless session: " + s
}

// Alive reports whether the process is still running.
func (k *Kernel) Alive() bool {
	select {
	case <-k.exited:
		return false
	default:
		return true
	}
}

func (k *Kernel) send(msg any) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	k.wmu.Lock()
	defer k.wmu.Unlock()
	_, err = k.stdin.Write(append(b, '\n'))
	return err
}

// Run executes code and waits for its result. When ctx is cancelled it asks
// Python to interrupt the cell, and ends the process if the cell does not stop.
func (k *Kernel) Run(ctx context.Context, code string) (nbexec.Output, error) {
	id := k.nextID.Add(1)
	if err := k.send(map[string]any{"op": "run", "id": id, "code": code}); err != nil {
		return nbexec.Output{}, ErrGone
	}
	var cancelled <-chan time.Time
	done := ctx.Done()
	for {
		select {
		case line := <-k.lines:
			var reply struct {
				ID int64 `json:"id"`
				nbexec.Output
			}
			if json.Unmarshal(line, &reply) != nil || reply.ID != id {
				continue
			}
			return normalize(reply.Output), nil
		case <-k.exited:
			return nbexec.Output{}, fmt.Errorf("%w: %s", ErrGone, lastLine(k.tail.String()))
		case <-done:
			done = nil
			_ = k.send(map[string]any{"op": "cancel", "id": id})
			cancelled = time.After(cancelWait)
		case <-cancelled:
			k.Close()
			out := nbexec.Failed("")
			out.Status = "cancelled"
			out.Error = "The cell did not stop, so its Python session was ended. Variables from earlier cells are gone."
			return out, nil
		}
	}
}

func normalize(o nbexec.Output) nbexec.Output {
	if o.Columns == nil {
		o.Columns = []nbexec.Column{}
	}
	if o.Rows == nil {
		o.Rows = [][]*string{}
	}
	if o.Images == nil {
		o.Images = []string{}
	}
	if o.ImageNotes == nil {
		o.ImageNotes = []string{}
	}
	if o.Kind == "" {
		o.Kind = "none"
	}
	return o
}

// Close ends the session: it closes stdin so Python exits, and kills the
// process if it has not exited shortly after.
func (k *Kernel) Close() {
	k.closeOnce.Do(func() {
		close(k.stop)
		_ = k.stdin.Close()
		select {
		case <-k.exited:
		case <-time.After(2 * time.Second):
			_ = k.cmd.Process.Kill()
			<-k.exited
		}
	})
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// tailBuffer keeps the last bytes written to it, for error messages.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
