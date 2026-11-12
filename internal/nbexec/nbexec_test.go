package nbexec

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func init() {
	pollStart = time.Millisecond
	pollMax = 2 * time.Millisecond
}

// fake replays canned JSON responses keyed by "METHOD path". The last
// response for a key repeats.
type fake struct {
	mu        sync.Mutex
	responses map[string][]string
	calls     []string
	bodies    []any
	onCall    func(key string)
}

func (f *fake) Do(ctx context.Context, method, path string, _ map[string]string,
	_ map[string]any, request, response any, _ ...func(*http.Request) error) error {
	key := method + " " + path
	f.mu.Lock()
	f.calls = append(f.calls, key)
	f.bodies = append(f.bodies, request)
	queue := f.responses[key]
	var body string
	if len(queue) > 0 {
		body = queue[0]
		if len(queue) > 1 {
			f.responses[key] = queue[1:]
		}
	}
	hook := f.onCall
	f.mu.Unlock()

	if hook != nil {
		hook(key)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.HasPrefix(body, "ERR:") {
		return errors.New(strings.TrimPrefix(body, "ERR:"))
	}
	if body == "" || response == nil {
		return nil
	}
	return json.Unmarshal([]byte(body), response)
}

func (f *fake) count(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == key {
			n++
		}
	}
	return n
}

const (
	kCreate  = "POST " + contextsCreate
	kCtxStat = "GET " + contextsStatus
	kDestroy = "POST " + contextsDestroy
	kExec    = "POST " + commandsExecute
	kStatus  = "GET " + commandsStatus
	kCancel  = "POST " + commandsCancel
)

func readyContext(id string) map[string][]string {
	return map[string][]string{
		kCreate:  {`{"id":"` + id + `"}`},
		kCtxStat: {`{"status":"Pending"}`, `{"status":"Running"}`},
	}
}

func TestCreateContextWaitsUntilRunning(t *testing.T) {
	f := &fake{responses: readyContext("ctx1")}
	id, err := CreateContext(context.Background(), f, "c1")
	if err != nil || id != "ctx1" {
		t.Fatalf("got %q, %v", id, err)
	}
	if n := f.count(kCtxStat); n != 2 {
		t.Fatalf("polled %d times, want 2", n)
	}
	body := f.bodies[0].(map[string]string)
	if body["language"] != "python" || body["clusterId"] != "c1" {
		t.Fatalf("create body %v", body)
	}
}

func TestCreateContextError(t *testing.T) {
	f := &fake{responses: map[string][]string{kCreate: {`{"id":"x"}`}, kCtxStat: {`{"status":"Error"}`}}}
	if _, err := CreateContext(context.Background(), f, "c1"); err == nil {
		t.Fatal("want an error")
	}
}

func run(t *testing.T, status string) Output {
	t.Helper()
	f := &fake{responses: map[string][]string{
		kExec:   {`{"id":"cmd1"}`},
		kStatus: {`{"status":"Running"}`, status},
	}}
	out, err := Run(context.Background(), f, "c1", "ctx1", "x = 1")
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRunText(t *testing.T) {
	out := run(t, `{"status":"Finished","results":{"resultType":"text","data":"\u001b[31mhello\u001b[0m\n"}}`)
	if out.Status != "finished" || out.Kind != "text" || out.Text != "hello\n" {
		t.Fatalf("%+v", out)
	}
}

func TestRunEmptyText(t *testing.T) {
	out := run(t, `{"status":"Finished","results":{"resultType":"text","data":""}}`)
	if out.Status != "finished" || out.Kind != "none" {
		t.Fatalf("%+v", out)
	}
}

func TestRunTable(t *testing.T) {
	out := run(t, `{"status":"Finished","results":{"resultType":"table",
		"schema":[{"name":"id","type":"\"long\""},{"name":"name","type":"\"string\""},{"name":"tags","type":{"type":"array"}}],
		"data":[[1,"a",["x","y"]],[2,null,null]],"truncated":true}}`)
	if out.Kind != "table" || !out.Truncated {
		t.Fatalf("%+v", out)
	}
	want := []Column{{"id", "long"}, {"name", "string"}, {"tags", "array"}}
	if fmt.Sprint(out.Columns) != fmt.Sprint(want) {
		t.Fatalf("columns %v", out.Columns)
	}
	if *out.Rows[0][0] != "1" || *out.Rows[0][1] != "a" || *out.Rows[0][2] != `["x","y"]` {
		t.Fatalf("row 0 %v", out.Rows[0])
	}
	if out.Rows[1][1] != nil {
		t.Fatal("null should stay nil")
	}
}

func TestRunError(t *testing.T) {
	out := run(t, `{"status":"Finished","results":{"resultType":"error",
		"summary":"<span class='ansi-red-fg'>NameError</span>: name &#39;y&#39; is not defined",
		"cause":"\u001b[0;31mTraceback\u001b[0m\nNameError: name 'y' is not defined"}}`)
	if out.Status != "error" || out.Error != "NameError: name 'y' is not defined" {
		t.Fatalf("%+v", out)
	}
	if strings.Contains(out.Detail, "\x1b") {
		t.Fatalf("detail kept ANSI codes: %q", out.Detail)
	}
}

func TestRunErrorWithoutSummary(t *testing.T) {
	out := run(t, `{"status":"Error","results":{"resultType":"error","cause":"Traceback\nValueError: bad"}}`)
	if out.Status != "error" || out.Error != "ValueError: bad" {
		t.Fatalf("%+v", out)
	}
}

func TestRunInlineImage(t *testing.T) {
	out := run(t, `{"status":"Finished","results":{"resultType":"images","fileNames":["data:image/png;base64,AAAA"]}}`)
	if out.Kind != "image" || len(out.Images) != 1 || out.Images[0] != "data:image/png;base64,AAAA" {
		t.Fatalf("%+v", out)
	}
}

func TestRunDBFSImage(t *testing.T) {
	png := "iVBORw0KGgo=" // the PNG signature
	f := &fake{responses: map[string][]string{
		kExec:             {`{"id":"cmd1"}`},
		kStatus:           {`{"status":"Finished","results":{"resultType":"image","fileName":"/plots/a.png"}}`},
		"GET " + dbfsRead: {`{"bytes_read":8,"data":"` + png + `"}`, `{"bytes_read":0,"data":""}`},
	}}
	out, err := Run(context.Background(), f, "c1", "ctx1", "plot()")
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Images) != 1 || !strings.HasPrefix(out.Images[0], "data:image/png;base64,") {
		t.Fatalf("%+v", out)
	}
}

func TestRunImageNotLoaded(t *testing.T) {
	f := &fake{responses: map[string][]string{
		kExec:             {`{"id":"cmd1"}`},
		kStatus:           {`{"status":"Finished","results":{"resultType":"image","fileName":"/plots/a.png"}}`},
		"GET " + dbfsRead: {`ERR:DBFS root is disabled`},
	}}
	out, _ := Run(context.Background(), f, "c1", "ctx1", "plot()")
	if len(out.Images) != 0 || len(out.ImageNotes) != 1 || !strings.Contains(out.ImageNotes[0], "DBFS root is disabled") {
		t.Fatalf("%+v", out)
	}
}

func TestRunContextGone(t *testing.T) {
	f := &fake{responses: map[string][]string{kExec: {`ERR:ContextNotFound: context abc not found`}}}
	_, err := Run(context.Background(), f, "c1", "ctx1", "x")
	if !errors.Is(err, ErrContextGone) {
		t.Fatalf("got %v", err)
	}
}

func TestRunCancelSendsCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	f := &fake{responses: map[string][]string{
		kExec:   {`{"id":"cmd1"}`},
		kStatus: {`{"status":"Running"}`, `{"status":"Running"}`, `{"status":"Cancelled"}`},
	}}
	f.onCall = func(key string) {
		if key == kStatus {
			cancel()
		}
	}
	out, err := Run(ctx, f, "c1", "ctx1", "import time; time.sleep(60)")
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "cancelled" || f.count(kCancel) != 1 {
		t.Fatalf("%+v, cancels %d", out, f.count(kCancel))
	}
	if out.Error != "" {
		t.Fatalf("cancel should be confirmed: %q", out.Error)
	}
}

func TestSessionsReuseContext(t *testing.T) {
	resp := readyContext("ctx1")
	resp[kExec] = []string{`{"id":"cmd"}`}
	resp[kStatus] = []string{`{"status":"Finished","results":{"resultType":"text","data":"42"}}`}
	f := &fake{responses: resp}
	s := NewSessions()
	_, info, err := s.Run(context.Background(), f, "nb", "c1", "x = 41")
	if err != nil || !info.Started {
		t.Fatalf("first run %+v %v", info, err)
	}
	out, info, err := s.Run(context.Background(), f, "nb", "c1", "x + 1")
	if err != nil || info.Started || out.Text != "42" {
		t.Fatalf("second run %+v %+v %v", out, info, err)
	}
	if n := f.count(kCreate); n != 1 {
		t.Fatalf("created %d contexts, want 1", n)
	}
	if s.Active("nb") != "c1" {
		t.Fatal("session should be active on c1")
	}
}

func TestSessionsSwitchClusterDestroysOld(t *testing.T) {
	resp := readyContext("ctx1")
	resp[kExec] = []string{`{"id":"cmd"}`}
	resp[kStatus] = []string{`{"status":"Finished"}`}
	f := &fake{responses: resp}
	s := NewSessions()
	s.Run(context.Background(), f, "nb", "c1", "x")
	_, info, _ := s.Run(context.Background(), f, "nb", "c2", "x")
	if !info.Started || f.count(kDestroy) != 1 {
		t.Fatalf("%+v destroys %d", info, f.count(kDestroy))
	}
}

func TestSessionsRecoverLostContext(t *testing.T) {
	resp := readyContext("ctx1")
	resp[kExec] = []string{`{"id":"cmd"}`, `ERR:context ctx1 does not exist`, `{"id":"cmd"}`}
	resp[kStatus] = []string{`{"status":"Finished"}`}
	f := &fake{responses: resp}
	s := NewSessions()
	s.Run(context.Background(), f, "nb", "c1", "x = 1")
	out, info, err := s.Run(context.Background(), f, "nb", "c1", "print(x)")
	if err != nil || !info.Lost || !info.Started || out.Status != "finished" {
		t.Fatalf("%+v %+v %v", out, info, err)
	}
	if n := f.count(kExec); n != 3 {
		t.Fatalf("executed %d times, want 3", n)
	}
}

func TestSessionsEnd(t *testing.T) {
	resp := readyContext("ctx1")
	resp[kExec] = []string{`{"id":"cmd"}`}
	resp[kStatus] = []string{`{"status":"Finished"}`}
	f := &fake{responses: resp}
	s := NewSessions()
	s.Run(context.Background(), f, "nb", "c1", "x")
	s.End(context.Background(), "nb")
	if f.count(kDestroy) != 1 || s.Active("nb") != "" {
		t.Fatal("End should destroy the context")
	}
	_, info, _ := s.Run(context.Background(), f, "nb", "c1", "x")
	if !info.Started {
		t.Fatal("a run after End starts a new session")
	}
}

func TestSessionsQueueRunsAndCancelWaiting(t *testing.T) {
	release := make(chan struct{})
	resp := readyContext("ctx1")
	resp[kExec] = []string{`{"id":"cmd"}`}
	resp[kStatus] = []string{`{"status":"Finished"}`}
	f := &fake{responses: resp}
	f.onCall = func(key string) {
		if key == kExec {
			<-release
		}
	}
	s := NewSessions()
	done := make(chan struct{})
	go func() {
		s.Run(context.Background(), f, "nb", "c1", "slow")
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, _, _ := s.Run(ctx, f, "nb", "c1", "queued")
	if out.Status != "cancelled" {
		t.Fatalf("a cancelled queued run should not wait: %+v", out)
	}
	close(release)
	<-done
}
