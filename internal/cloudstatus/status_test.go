package cloudstatus

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const sample = `{"result":{"status":[
 {"name":"Compute","status_code":500,"containers":[{"id":"east","name":"US East 1","status":"Operational","status_code":100},{"id":"west","name":"US West 2","status":"Service Disruption","status_code":500}]},
 {"name":"SQL","status_code":300,"containers":[{"id":"east","name":"US East 1","status":"Degraded Performance","status_code":300},{"id":"west","name":"US West 2","status":"Operational","status_code":100}]}
 ],"maintenance":{"upcoming":[{"name":"Planned work","containers_affected":[{"_id":"east"}]}]}}}`

func parse(t *testing.T, body string) feed {
	t.Helper()
	var f feed
	if err := json.Unmarshal([]byte(body), &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestRegionalHealth(t *testing.T) {
	f := parse(t, sample)
	regions, err := f.regions()
	if err != nil {
		t.Fatal(err)
	}
	if regions[0].Health != "degraded" || regions[1].Health != "outage" {
		t.Fatalf("wrong regional rollup: %+v", regions)
	}
	// Provider-wide and service-wide degradation in another region cannot make
	// an otherwise healthy region non-green. Scheduled work is not active work.
	f.Result.Status[1].Containers[0].Code = 100
	regions, _ = f.regions()
	if regions[0].Health != "operational" || len(regions[0].Events) != 1 || len(regions[1].Events) != 0 {
		t.Fatalf("unrelated outage or scheduled maintenance leaked into health: %+v", regions)
	}
	// Unknown codes must never be treated as operational.
	f.Result.Status[0].Containers[0].Code = 999
	regions, _ = f.regions()
	if regions[0].Health != "unknown" {
		t.Fatal("unknown status should not be green")
	}
}

func TestActiveEventsAndGlobalServices(t *testing.T) {
	for _, tc := range []struct{ extra, want string }{
		{`"incidents":[{"name":"Issue","containers_affected":[{"_id":"east"}]}]`, "degraded"},
		{`"maintenance":{"active":[{"name":"Work","containers_affected":[{"_id":"east"}]}]}`, "maintenance"},
	} {
		f := parse(t, `{"result":{"status":[{"name":"Compute","containers":[{"id":"east","name":"East","status_code":100},{"id":"west","name":"West","status_code":100}]}],`+tc.extra+`}}`)
		r, err := f.regions()
		if err != nil || r[0].Health != tc.want || r[1].Health != "operational" {
			t.Fatalf("events: %+v %v", r, err)
		}
		f.Result.Status = append(f.Result.Status, component{Name: "Global auth", Code: 600})
		r, _ = f.regions()
		if r[0].Health != "security" || r[1].Health != "security" {
			t.Fatal("global service did not affect all regions")
		}
	}
}

func TestFeedErrors(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"http", sample, 503}, {"html", "<html>unavailable</html>", 200},
		{"missing regions", `{"result":{"status":[]}}`, 200},
		{"unnamed region", `{"result":{"status":[{"name":"SQL","containers":[{"id":"a","status_code":100}]}]}}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); io.WriteString(w, tc.body) }))
			defer srv.Close()
			if _, err := NewClient().fetch(context.Background(), srv.URL); err == nil {
				t.Fatal("bad feed must fail")
			}
		})
	}
}

type transportFunc func(*http.Request) (*http.Response, error)

func (fn transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func TestCacheAndFailedRefresh(t *testing.T) {
	c := NewClient()
	calls, status := 0, 200
	c.http.Transport = transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(sample)), Header: make(http.Header)}, nil
	})
	first := c.provider(context.Background(), 0, false)
	second := c.provider(context.Background(), 0, false)
	if calls != 1 || first.FetchedAt == 0 || second.FetchedAt != first.FetchedAt {
		t.Fatal("successful feed should be cached")
	}
	first = c.provider(context.Background(), 0, true)
	if calls != 2 || first.Error != "" {
		t.Fatal("manual refresh must bypass the cache")
	}
	status = 503
	failed := c.provider(context.Background(), 0, true)
	if failed.Error == "" || failed.FetchedAt != first.FetchedAt || len(failed.Regions) == 0 {
		t.Fatal("failed refresh must retain old data with an explicit error")
	}
	c.provider(context.Background(), 0, false)
	if calls != 3 {
		t.Fatal("error should be cached briefly")
	}
}
