package sqlexec

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

// fake replays canned JSON responses keyed by "METHOD path".
type fake struct {
	mu        sync.Mutex
	responses map[string][]string
	calls     []string
	requests  []any
	onCall    func(key string)
}

func (f *fake) Do(ctx context.Context, method, path string, _ map[string]string,
	_ map[string]any, request, response any, _ ...func(*http.Request) error) error {
	key := method + " " + path
	f.mu.Lock()
	f.calls = append(f.calls, key)
	f.requests = append(f.requests, request)
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
	if body == "" {
		if response == nil {
			return nil
		}
		return fmt.Errorf("no canned response for %s", key)
	}
	if strings.HasPrefix(body, "ERR:") {
		return errors.New(strings.TrimPrefix(body, "ERR:"))
	}
	if response == nil {
		return nil
	}
	return json.Unmarshal([]byte(body), response)
}

func (f *fake) called(key string) int {
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

func fastPolling(t *testing.T) {
	t.Helper()
	oldStart, oldMax := pollStart, pollMax
	pollStart, pollMax = time.Millisecond, 2*time.Millisecond
	t.Cleanup(func() { pollStart, pollMax = oldStart, oldMax })
}

const post = "POST /api/2.0/sql/statements"

func TestRunSucceedsImmediatelyWithNulls(t *testing.T) {
	f := &fake{responses: map[string][]string{post: {`{
		"statement_id": "s1",
		"status": {"state": "SUCCEEDED"},
		"manifest": {"schema": {"columns": [
			{"name": "id", "type_text": "BIGINT"}, {"name": "note", "type_text": "STRING"}]}},
		"result": {"data_array": [["1", null], ["2", ""]]}
	}`}}}
	res := Run(context.Background(), f, "wh1", "SELECT 1")

	if res.Status != "SUCCEEDED" || res.StatementID != "s1" || res.Error != "" || res.Truncated {
		t.Fatalf("%+v", res)
	}
	if len(res.Columns) != 2 || res.Columns[1] != (Column{Name: "note", Type: "STRING"}) {
		t.Fatalf("columns: %+v", res.Columns)
	}
	if len(res.Rows) != 2 {
		t.Fatalf("rows: %v", res.Rows)
	}
	if res.Rows[0][1] != nil {
		t.Error("SQL NULL must stay nil, not become an empty string")
	}
	if res.Rows[1][1] == nil || *res.Rows[1][1] != "" {
		t.Error("an empty string must stay an empty string, not become NULL")
	}

	req, ok := f.requests[0].(executeRequest)
	if !ok {
		t.Fatalf("request type %T", f.requests[0])
	}
	if req.WarehouseID != "wh1" || req.Statement != "SELECT 1" || req.RowLimit != RowLimit ||
		req.WaitTimeout != "0s" || req.Disposition != "INLINE" || req.Format != "JSON_ARRAY" {
		t.Errorf("request: %+v", req)
	}
}

func TestRunPollsUntilDone(t *testing.T) {
	fastPolling(t)
	get := "GET /api/2.0/sql/statements/s2"
	f := &fake{responses: map[string][]string{
		post: {`{"statement_id": "s2", "status": {"state": "PENDING"}}`},
		get: {
			`{"statement_id": "s2", "status": {"state": "RUNNING"}}`,
			`{"statement_id": "s2", "status": {"state": "SUCCEEDED"},
			  "manifest": {"schema": {"columns": [{"name": "n", "type_text": "INT"}]}},
			  "result": {"data_array": [["7"]]}}`,
		},
	}}
	res := Run(context.Background(), f, "wh", "SELECT 7")
	if res.Status != "SUCCEEDED" || len(res.Rows) != 1 || *res.Rows[0][0] != "7" {
		t.Fatalf("%+v", res)
	}
	if n := f.called(get); n != 2 {
		t.Errorf("polled %d times, want 2", n)
	}
}

func TestRunFollowsChunks(t *testing.T) {
	f := &fake{responses: map[string][]string{
		post: {`{"statement_id": "s3", "status": {"state": "SUCCEEDED"},
			"manifest": {"schema": {"columns": [{"name": "n", "type_text": "INT"}]}},
			"result": {"data_array": [["1"], ["2"]], "next_chunk_index": 1}}`},
		"GET /api/2.0/sql/statements/s3/result/chunks/1": {`{"data_array": [["3"]], "next_chunk_index": 2}`},
		"GET /api/2.0/sql/statements/s3/result/chunks/2": {`{"data_array": [["4"]]}`},
	}}
	res := Run(context.Background(), f, "wh", "SELECT n")
	if res.Status != "SUCCEEDED" || len(res.Rows) != 4 || *res.Rows[3][0] != "4" || res.Truncated {
		t.Fatalf("%+v", res)
	}
}

func TestRunCapsRows(t *testing.T) {
	rows := make([]string, RowLimit+5)
	for i := range rows {
		rows[i] = `["x"]`
	}
	f := &fake{responses: map[string][]string{post: {`{"statement_id": "s4", "status": {"state": "SUCCEEDED"},
		"manifest": {"schema": {"columns": [{"name": "c", "type_text": "STRING"}]}},
		"result": {"data_array": [` + strings.Join(rows, ",") + `]}}`}}}
	res := Run(context.Background(), f, "wh", "SELECT c")
	if len(res.Rows) != RowLimit || !res.Truncated {
		t.Fatalf("rows=%d truncated=%v", len(res.Rows), res.Truncated)
	}
}

func TestRunReportsManifestTruncation(t *testing.T) {
	f := &fake{responses: map[string][]string{post: {`{"statement_id": "s5", "status": {"state": "SUCCEEDED"},
		"manifest": {"truncated": true, "schema": {"columns": []}}, "result": {"data_array": []}}`}}}
	if res := Run(context.Background(), f, "wh", "SELECT 1"); !res.Truncated {
		t.Fatal("manifest truncation should be reported")
	}
}

func TestRunFailedStatement(t *testing.T) {
	f := &fake{responses: map[string][]string{post: {`{"statement_id": "s6",
		"status": {"state": "FAILED", "error": {"error_code": "BAD_REQUEST", "message": " [TABLE_OR_VIEW_NOT_FOUND] nope "}}}`}}}
	res := Run(context.Background(), f, "wh", "SELECT * FROM nope")
	if res.Status != "FAILED" || res.Error != "[TABLE_OR_VIEW_NOT_FOUND] nope" {
		t.Fatalf("%+v", res)
	}
	if res.Rows == nil || res.Columns == nil {
		t.Error("rows and columns should be empty slices, not nil")
	}
}

func TestRunTransportError(t *testing.T) {
	f := &fake{responses: map[string][]string{post: {"ERR:connection refused\nstack"}}}
	res := Run(context.Background(), f, "wh", "SELECT 1")
	if res.Status != "FAILED" || res.Error != "connection refused" {
		t.Fatalf("%+v", res)
	}
}

func TestRunCancelWhileRunning(t *testing.T) {
	fastPolling(t)
	ctx, cancelCtx := context.WithCancel(context.Background())
	get := "GET /api/2.0/sql/statements/s7"
	f := &fake{responses: map[string][]string{
		post: {`{"statement_id": "s7", "status": {"state": "RUNNING"}}`},
		get:  {`{"statement_id": "s7", "status": {"state": "RUNNING"}}`},
	}}
	f.onCall = func(key string) {
		if key == get && f.called(get) == 3 {
			cancelCtx()
		}
	}
	res := Run(ctx, f, "wh", "SELECT sleep")
	if res.Status != "CANCELED" || res.StatementID != "s7" {
		t.Fatalf("%+v", res)
	}
	if n := f.called("POST /api/2.0/sql/statements/s7/cancel"); n != 1 {
		t.Errorf("cancel was sent %d times, want 1", n)
	}
}

func TestRunServerSideCancel(t *testing.T) {
	f := &fake{responses: map[string][]string{post: {`{"statement_id": "s8", "status": {"state": "CANCELED"}}`}}}
	if res := Run(context.Background(), f, "wh", "SELECT 1"); res.Status != "CANCELED" {
		t.Fatalf("%+v", res)
	}
}
