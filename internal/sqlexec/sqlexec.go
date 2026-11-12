// Package sqlexec runs one SQL statement on a warehouse through the
// Databricks Statement Execution API and collects a capped set of rows.
//
// It talks to the REST API directly, not through the SDK's typed result,
// because the typed result turns SQL NULL into an empty string.
package sqlexec

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// RowLimit is the most rows a single run returns.
const RowLimit = 10000

const statementsPath = "/api/2.0/sql/statements"

// Polling starts fast so short queries feel instant, then backs off.
var (
	pollStart = 250 * time.Millisecond
	pollMax   = 1500 * time.Millisecond
)

// Doer is the part of the SDK's API client this package needs.
type Doer interface {
	Do(ctx context.Context, method, path string, headers map[string]string,
		queryParams map[string]any, request, response any,
		visitors ...func(*http.Request) error) error
}

// Column is one column of a result.
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// Result is the outcome of running a statement.
type Result struct {
	StatementID string `json:"statementId"`
	// Status is SUCCEEDED, FAILED or CANCELED.
	Status  string   `json:"status"`
	Columns []Column `json:"columns"`
	// Rows holds each value as text; nil is SQL NULL.
	Rows [][]*string `json:"rows"`
	// Truncated is true when the statement produced more rows than returned.
	Truncated  bool   `json:"truncated"`
	Error      string `json:"error"`
	DurationMs int64  `json:"durationMs"`
}

type executeRequest struct {
	Statement     string `json:"statement"`
	WarehouseID   string `json:"warehouse_id"`
	WaitTimeout   string `json:"wait_timeout"`
	OnWaitTimeout string `json:"on_wait_timeout"`
	Disposition   string `json:"disposition"`
	Format        string `json:"format"`
	RowLimit      int    `json:"row_limit"`
}

type chunk struct {
	DataArray      [][]*string `json:"data_array"`
	NextChunkIndex *int        `json:"next_chunk_index"`
}

type statementResponse struct {
	StatementID string `json:"statement_id"`
	Status      struct {
		State string `json:"state"`
		Error *struct {
			ErrorCode string `json:"error_code"`
			Message   string `json:"message"`
		} `json:"error"`
	} `json:"status"`
	Manifest struct {
		Schema struct {
			Columns []struct {
				Name     string `json:"name"`
				TypeText string `json:"type_text"`
			} `json:"columns"`
		} `json:"schema"`
		Truncated bool `json:"truncated"`
	} `json:"manifest"`
	Result *chunk `json:"result"`
}

var jsonHeaders = map[string]string{
	"Content-Type": "application/json",
	"Accept":       "application/json",
}

// Run executes a statement and waits for it to finish. Cancelling ctx cancels
// the statement on the warehouse and returns a CANCELED result. Run never
// returns a Go error: failures are reported in Result.Error.
func Run(ctx context.Context, d Doer, warehouseID, statement string) Result {
	start := time.Now()
	res := run(ctx, d, warehouseID, statement)
	res.DurationMs = time.Since(start).Milliseconds()
	if res.Columns == nil {
		res.Columns = []Column{}
	}
	if res.Rows == nil {
		res.Rows = [][]*string{}
	}
	return res
}

func run(ctx context.Context, d Doer, warehouseID, statement string) Result {
	var resp statementResponse
	err := d.Do(ctx, http.MethodPost, statementsPath, jsonHeaders, nil, executeRequest{
		Statement:     statement,
		WarehouseID:   warehouseID,
		WaitTimeout:   "0s",
		OnWaitTimeout: "CONTINUE",
		Disposition:   "INLINE",
		Format:        "JSON_ARRAY",
		RowLimit:      RowLimit,
	}, &resp)
	if err != nil {
		if ctx.Err() != nil {
			return Result{Status: "CANCELED"}
		}
		return Result{Status: "FAILED", Error: firstLine(err.Error())}
	}
	id := resp.StatementID

	wait := pollStart
	for resp.Status.State == "PENDING" || resp.Status.State == "RUNNING" {
		select {
		case <-ctx.Done():
			cancel(d, id)
			return Result{StatementID: id, Status: "CANCELED"}
		case <-time.After(wait):
		}
		if wait = wait * 3 / 2; wait > pollMax {
			wait = pollMax
		}
		resp = statementResponse{}
		if err := d.Do(ctx, http.MethodGet, statementsPath+"/"+id, jsonHeaders, nil, nil, &resp); err != nil {
			if ctx.Err() != nil {
				cancel(d, id)
				return Result{StatementID: id, Status: "CANCELED"}
			}
			return Result{StatementID: id, Status: "FAILED", Error: firstLine(err.Error())}
		}
	}

	switch resp.Status.State {
	case "SUCCEEDED":
	case "CANCELED", "CLOSED":
		return Result{StatementID: id, Status: "CANCELED"}
	default:
		msg := "The statement failed."
		if e := resp.Status.Error; e != nil && e.Message != "" {
			msg = strings.TrimSpace(e.Message)
		}
		return Result{StatementID: id, Status: "FAILED", Error: msg}
	}

	res := Result{StatementID: id, Status: "SUCCEEDED", Truncated: resp.Manifest.Truncated}
	for _, c := range resp.Manifest.Schema.Columns {
		res.Columns = append(res.Columns, Column{Name: c.Name, Type: c.TypeText})
	}
	c := resp.Result
	for c != nil {
		res.Rows = append(res.Rows, c.DataArray...)
		if len(res.Rows) >= RowLimit {
			if len(res.Rows) > RowLimit || c.NextChunkIndex != nil {
				res.Truncated = true
			}
			res.Rows = res.Rows[:RowLimit]
			break
		}
		if c.NextChunkIndex == nil {
			break
		}
		next := &chunk{}
		path := fmt.Sprintf("%s/%s/result/chunks/%d", statementsPath, id, *c.NextChunkIndex)
		if err := d.Do(ctx, http.MethodGet, path, jsonHeaders, nil, nil, next); err != nil {
			if ctx.Err() != nil {
				return Result{StatementID: id, Status: "CANCELED"}
			}
			return Result{StatementID: id, Status: "FAILED", Error: "Could not fetch all rows: " + firstLine(err.Error())}
		}
		c = next
	}
	return res
}

// cancel asks the warehouse to stop a statement. It uses its own context
// because the caller's is already cancelled.
func cancel(d Doer, id string) {
	if id == "" {
		return
	}
	ctx, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	_ = d.Do(ctx, http.MethodPost, statementsPath+"/"+id+"/cancel", jsonHeaders, nil, nil, nil)
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "\n"); i > 0 {
		s = s[:i]
	}
	return s
}
