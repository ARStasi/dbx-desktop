// Package nbexec runs notebook cells on an all-purpose cluster through the
// Databricks Command Execution API (API 1.2).
//
// A session is one Python execution context on a cluster. Variables, imports
// and the Spark session persist between cells run in the same context, which
// is what makes cell-by-cell notebook work possible. A context ends when it is
// destroyed or when the cluster restarts or terminates.
//
// It talks to the REST API directly, like sqlexec, so it can keep table
// values as text and turn every result type into one shape for the UI.
package nbexec

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// RowLimit is the most table rows a cell result keeps.
const RowLimit = 10000

// maxImageBytes caps an image fetched from DBFS for one plot.
const maxImageBytes = 8 << 20

const (
	contextsCreate  = "/api/1.2/contexts/create"
	contextsStatus  = "/api/1.2/contexts/status"
	contextsDestroy = "/api/1.2/contexts/destroy"
	commandsExecute = "/api/1.2/commands/execute"
	commandsStatus  = "/api/1.2/commands/status"
	commandsCancel  = "/api/1.2/commands/cancel"
	dbfsRead        = "/api/2.0/dbfs/read"
)

// Polling starts fast so short cells feel instant, then backs off.
var (
	pollStart = 200 * time.Millisecond
	pollMax   = 1500 * time.Millisecond
	// contextWait is how long a new context may take to become ready.
	contextWait = 3 * time.Minute
	// cancelWait is how long to wait for a cancelled command to stop.
	cancelWait = 20 * time.Second
)

// Doer is the part of the SDK's API client this package needs.
type Doer interface {
	Do(ctx context.Context, method, path string, headers map[string]string,
		queryParams map[string]any, request, response any,
		visitors ...func(*http.Request) error) error
}

// Column is one column of a table result.
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Output is what a cell produced.
type Output struct {
	// Status is finished, error (the code raised), cancelled, or failed (the
	// app could not run it, for example because the cluster is not running).
	Status string `json:"status"`
	// Kind is text, table, image or none for a finished cell.
	Kind string `json:"kind"`
	Text string `json:"text"`
	// Columns and Rows hold a table result. A nil value is null.
	Columns   []Column    `json:"columns"`
	Rows      [][]*string `json:"rows"`
	Truncated bool        `json:"truncated"`
	// Images are data: URLs.
	Images []string `json:"images"`
	// ImageNotes lists images that could not be loaded, with why.
	ImageNotes []string `json:"imageNotes"`
	// Error is a short summary, and Detail the traceback, for an error or failure.
	Error      string `json:"error"`
	Detail     string `json:"detail"`
	DurationMs int64  `json:"durationMs"`
}

func newOutput(status string) Output {
	return Output{Status: status, Kind: "none", Columns: []Column{}, Rows: [][]*string{}, Images: []string{}, ImageNotes: []string{}}
}

// Failed is an Output for a cell the app could not run.
func Failed(msg string) Output {
	o := newOutput("failed")
	o.Error = msg
	return o
}

// ErrContextGone means the execution context no longer exists on the cluster,
// usually because the cluster restarted. Its variables are lost.
var ErrContextGone = errors.New("the Python session on the cluster has ended")

type idResponse struct {
	ID string `json:"id"`
}

// CreateContext starts a Python execution context on a running cluster and
// waits until it is ready.
func CreateContext(ctx context.Context, api Doer, clusterID string) (string, error) {
	var created idResponse
	err := api.Do(ctx, http.MethodPost, contextsCreate, nil, nil,
		map[string]string{"clusterId": clusterID, "language": "python"}, &created)
	if err != nil {
		return "", err
	}
	if created.ID == "" {
		return "", errors.New("the cluster did not return a session id")
	}
	deadline := time.Now().Add(contextWait)
	delay := pollStart
	for {
		var st struct {
			Status string `json:"status"`
		}
		err := api.Do(ctx, http.MethodGet, contextsStatus, nil,
			map[string]any{"clusterId": clusterID, "contextId": created.ID}, nil, &st)
		if err != nil {
			return "", err
		}
		switch st.Status {
		case "Running":
			return created.ID, nil
		case "Error":
			return "", errors.New("the cluster could not start a Python session")
		}
		if time.Now().After(deadline) {
			DestroyContext(context.Background(), api, clusterID, created.ID)
			return "", errors.New("the cluster took too long to start a Python session")
		}
		if err := sleep(ctx, delay); err != nil {
			DestroyContext(context.Background(), api, clusterID, created.ID)
			return "", err
		}
		delay = backoff(delay)
	}
}

// DestroyContext ends an execution context. Errors are ignored: the context
// may already be gone with its cluster.
func DestroyContext(ctx context.Context, api Doer, clusterID, contextID string) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_ = api.Do(ctx, http.MethodPost, contextsDestroy, nil, nil,
		map[string]string{"clusterId": clusterID, "contextId": contextID}, nil)
}

type rawResults struct {
	ResultType string            `json:"resultType"`
	Data       json.RawMessage   `json:"data"`
	Schema     []json.RawMessage `json:"schema"`
	Truncated  bool              `json:"truncated"`
	Summary    string            `json:"summary"`
	Cause      string            `json:"cause"`
	FileName   string            `json:"fileName"`
	FileNames  []string          `json:"fileNames"`
}

type commandStatus struct {
	ID      string      `json:"id"`
	Status  string      `json:"status"`
	Results *rawResults `json:"results"`
}

// Run executes Python code in a context and waits for its result. When ctx is
// cancelled the command is cancelled on the cluster too. It returns
// ErrContextGone, and runs nothing, when the context no longer exists.
func Run(ctx context.Context, api Doer, clusterID, contextID, code string) (Output, error) {
	start := time.Now()
	var created idResponse
	err := api.Do(ctx, http.MethodPost, commandsExecute, nil, nil, map[string]string{
		"clusterId": clusterID,
		"contextId": contextID,
		"language":  "python",
		"command":   code,
	}, &created)
	if err != nil {
		if contextMissing(err) {
			return Output{}, ErrContextGone
		}
		if ctx.Err() != nil {
			return newOutput("cancelled"), nil
		}
		return Output{}, err
	}

	q := map[string]any{"clusterId": clusterID, "contextId": contextID, "commandId": created.ID}
	delay := pollStart
	for {
		if err := sleep(ctx, delay); err != nil {
			return cancelCommand(api, clusterID, contextID, created.ID, start), nil
		}
		delay = backoff(delay)
		var st commandStatus
		if err := api.Do(ctx, http.MethodGet, commandsStatus, nil, q, nil, &st); err != nil {
			if ctx.Err() != nil {
				return cancelCommand(api, clusterID, contextID, created.ID, start), nil
			}
			if contextMissing(err) {
				return Output{}, ErrContextGone
			}
			return Output{}, err
		}
		switch st.Status {
		case "Finished", "Error", "Cancelled":
			out := convert(ctx, api, st)
			out.DurationMs = time.Since(start).Milliseconds()
			return out, nil
		}
	}
}

// cancelCommand asks the cluster to cancel a command and waits a little for
// it to stop, so the next cell does not queue behind it.
func cancelCommand(api Doer, clusterID, contextID, commandID string, start time.Time) Output {
	ctx, cancel := context.WithTimeout(context.Background(), cancelWait)
	defer cancel()
	out := newOutput("cancelled")
	err := api.Do(ctx, http.MethodPost, commandsCancel, nil, nil, map[string]string{
		"clusterId": clusterID, "contextId": contextID, "commandId": commandID,
	}, nil)
	if err == nil {
		q := map[string]any{"clusterId": clusterID, "contextId": contextID, "commandId": commandID}
		for delay := pollStart; ; delay = backoff(delay) {
			var st commandStatus
			if api.Do(ctx, http.MethodGet, commandsStatus, nil, q, nil, &st) != nil {
				break
			}
			if st.Status == "Cancelled" || st.Status == "Finished" || st.Status == "Error" {
				break
			}
			if sleep(ctx, delay) != nil {
				out.Error = "The cluster has not confirmed that the cell stopped."
				break
			}
		}
	} else {
		out.Error = "The cluster did not accept the cancel request, so the cell may still be running."
	}
	out.DurationMs = time.Since(start).Milliseconds()
	return out
}

func convert(ctx context.Context, api Doer, st commandStatus) Output {
	if st.Status == "Cancelled" {
		return newOutput("cancelled")
	}
	out := newOutput("finished")
	r := st.Results
	if r == nil {
		return out
	}
	switch r.ResultType {
	case "error":
		out.Status = "error"
		out.Error = cleanSummary(r.Summary)
		out.Detail = stripANSI(r.Cause)
		if out.Error == "" {
			out.Error = lastLine(out.Detail)
		}
		if out.Error == "" {
			out.Error = "The cell failed."
		}
	case "text":
		var s string
		if json.Unmarshal(r.Data, &s) == nil {
			out.Text = stripANSI(s)
		} else {
			out.Text = string(r.Data)
		}
		if out.Text != "" {
			out.Kind = "text"
		}
	case "table":
		out.Kind = "table"
		out.Columns = columns(r.Schema)
		out.Rows, out.Truncated = rows(r.Data)
		out.Truncated = out.Truncated || r.Truncated
	case "image", "images":
		out.Kind = "image"
		names := r.FileNames
		if r.FileName != "" {
			names = append([]string{r.FileName}, names...)
		}
		for _, n := range names {
			if url, err := image(ctx, api, n); err == nil {
				out.Images = append(out.Images, url)
			} else {
				out.ImageNotes = append(out.ImageNotes, err.Error())
			}
		}
	}
	if st.Status == "Error" && out.Status != "error" {
		out.Status = "error"
		if out.Error == "" {
			out.Error = "The cell failed."
		}
	}
	return out
}

func columns(schema []json.RawMessage) []Column {
	cols := make([]Column, 0, len(schema))
	for _, raw := range schema {
		var c struct {
			Name string          `json:"name"`
			Type json.RawMessage `json:"type"`
		}
		if json.Unmarshal(raw, &c) != nil {
			continue
		}
		var t string
		if json.Unmarshal(c.Type, &t) != nil {
			// A JSON schema describes complex types; keep its type name.
			var obj struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(c.Type, &obj) == nil && obj.Type != "" {
				t = obj.Type
			} else {
				t = string(c.Type)
			}
		}
		cols = append(cols, Column{Name: c.Name, Type: strings.Trim(t, `"`)})
	}
	return cols
}

// rows turns table data into text cells, keeping JSON null as nil.
func rows(data json.RawMessage) ([][]*string, bool) {
	var raw [][]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		return [][]*string{}, false
	}
	truncated := false
	if len(raw) > RowLimit {
		raw, truncated = raw[:RowLimit], true
	}
	out := make([][]*string, len(raw))
	for i, r := range raw {
		row := make([]*string, len(r))
		for j, v := range r {
			row[j] = cell(v)
		}
		out[i] = row
	}
	return out, truncated
}

func cell(v json.RawMessage) *string {
	s := strings.TrimSpace(string(v))
	if s == "null" || s == "" {
		return nil
	}
	var str string
	if s[0] == '"' && json.Unmarshal(v, &str) == nil {
		return &str
	}
	return &s
}

// image returns a data: URL for a plot, reading it from DBFS when the
// cluster saved it there instead of returning it inline.
func image(ctx context.Context, api Doer, name string) (string, error) {
	if strings.HasPrefix(name, "data:image/") {
		return name, nil
	}
	if !strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("an image came back in an unknown form")
	}
	p := name
	if strings.HasPrefix(p, "/plots/") {
		p = "/FileStore" + p
	}
	var buf []byte
	for offset := 0; ; {
		var res struct {
			BytesRead int    `json:"bytes_read"`
			Data      string `json:"data"`
		}
		err := api.Do(ctx, http.MethodGet, dbfsRead, nil,
			map[string]any{"path": p, "offset": offset, "length": 1 << 20}, nil, &res)
		if err != nil {
			return "", fmt.Errorf("could not load the image %s: %s", name, firstLine(err.Error()))
		}
		b, err := base64.StdEncoding.DecodeString(res.Data)
		if err != nil {
			return "", fmt.Errorf("the image %s came back in an unexpected form", name)
		}
		buf = append(buf, b...)
		if len(buf) > maxImageBytes {
			return "", fmt.Errorf("the image %s is larger than %d MB", name, maxImageBytes>>20)
		}
		if res.BytesRead == 0 || len(b) == 0 {
			break
		}
		offset += res.BytesRead
	}
	mime := http.DetectContentType(buf)
	if strings.HasSuffix(strings.ToLower(name), ".svg") {
		mime = "image/svg+xml"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(buf), nil
}

var (
	ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
	tagRe  = regexp.MustCompile(`</?[a-zA-Z][^>]*>`)
)

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }

// cleanSummary turns an error summary, which can hold HTML spans for
// terminal colors, into plain text.
func cleanSummary(s string) string {
	s = stripANSI(s)
	s = tagRe.ReplaceAllString(s, "")
	return strings.TrimSpace(html.UnescapeString(s))
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// contextMissing reports whether an API error says the execution context does
// not exist, which happens after a cluster restart.
func contextMissing(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "contextnotfound") ||
		(strings.Contains(msg, "context") && (strings.Contains(msg, "not found") || strings.Contains(msg, "does not exist")))
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func backoff(d time.Duration) time.Duration {
	d = d * 3 / 2
	if d > pollMax {
		d = pollMax
	}
	return d
}
