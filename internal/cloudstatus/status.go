// Package cloudstatus reads the public Databricks Status.io feeds. It does not
// use workspace credentials. Region health comes from each service's container,
// never the provider-wide rollup, which can include unrelated regions.
package cloudstatus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"sync"
	"time"
)

type Provider struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	URL       string   `json:"url"`
	Regions   []Region `json:"regions"`
	FetchedAt int64    `json:"fetchedAt"`
	Error     string   `json:"error"`
}

type Region struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Health   string    `json:"health"`
	Services []Service `json:"services"`
	Events   []Event   `json:"events"`
}

type Service struct {
	Name   string `json:"name"`
	Health string `json:"health"`
	Status string `json:"status"`
}

type Event struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	StartsAt string `json:"startsAt"`
	EndsAt   string `json:"endsAt"`
}

var sources = []struct{ id, name, url, pageID string }{
	{"aws", "AWS", "https://status.databricks.com", "5cf02dde58a00904bda41926"},
	{"azure", "Azure", "https://status.azuredatabricks.net", "5d49ec10226b9e13cb6a422e"},
	{"gcp", "GCP", "https://status.gcp.databricks.com", "60087ab5608daf0535dc8e23"},
}

type entry struct {
	mu        sync.Mutex
	value     Provider
	nextFetch time.Time
}

type Client struct {
	http    *http.Client
	entries [3]entry
}

func NewClient() *Client {
	return &Client{http: &http.Client{Timeout: 15 * time.Second}}
}

// Snapshot fetches providers independently so a failed feed leaves the others
// usable. Successful results are cached for five minutes, errors for one minute.
// A manual refresh bypasses the cache; background polling keeps its TTL.
func (c *Client) Snapshot(ctx context.Context, refresh bool) []Provider {
	out := make([]Provider, len(sources))
	var wg sync.WaitGroup
	for i := range sources {
		wg.Go(func() { out[i] = c.provider(ctx, i, refresh) })
	}
	wg.Wait()
	return out
}

func (c *Client) provider(ctx context.Context, i int, refresh bool) Provider {
	e, source := &c.entries[i], sources[i]
	e.mu.Lock()
	defer e.mu.Unlock()
	if !refresh && time.Now().Before(e.nextFetch) {
		return e.value
	}
	regions, err := c.fetch(ctx, source.url+"/1.0/status/"+source.pageID)
	if err != nil {
		e.value.ID, e.value.Name, e.value.URL = source.id, source.name, source.url
		e.value.Error = err.Error()
		e.nextFetch = time.Now().Add(time.Minute)
		return e.value
	}
	e.value = Provider{ID: source.id, Name: source.name, URL: source.url, Regions: regions, FetchedAt: time.Now().UnixMilli()}
	e.nextFetch = time.Now().Add(5 * time.Minute)
	return e.value
}

type component struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	Status     string      `json:"status"`
	Code       int         `json:"status_code"`
	Containers []component `json:"containers"`
}

type feedEvent struct {
	Name       string `json:"name"`
	StartsAt   string `json:"datetime_planned_start"`
	EndsAt     string `json:"datetime_planned_end"`
	Containers []struct {
		ID string `json:"_id"`
	} `json:"containers_affected"`
}

type feed struct {
	Result struct {
		Status      []component `json:"status"`
		Incidents   []feedEvent `json:"incidents"`
		Maintenance struct {
			Active   []feedEvent `json:"active"`
			Upcoming []feedEvent `json:"upcoming"`
		} `json:"maintenance"`
	} `json:"result"`
}

func (c *Client) fetch(ctx context.Context, url string) ([]Region, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "dbx-desktop")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Could not reach the status feed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Status feed returned HTTP %d", resp.StatusCode)
	}
	var f feed
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&f); err != nil {
		return nil, fmt.Errorf("Could not read the status feed: %w", err)
	}
	return f.regions()
}

// Health uses Status.io's numeric codes. Only an explicit 100 is green.
// https://kb.status.io/developers/status-codes/
func health(code int) string {
	switch code {
	case 100:
		return "operational"
	case 200:
		return "maintenance"
	case 300:
		return "degraded"
	case 400, 500:
		return "outage"
	case 600:
		return "security"
	default:
		return "unknown"
	}
}

func severity(h string) int {
	switch h {
	case "operational":
		return 0
	case "maintenance":
		return 1
	case "unknown":
		return 2
	case "degraded":
		return 3
	case "outage":
		return 4
	case "security":
		return 5
	default:
		return 2
	}
}

func (f feed) regions() ([]Region, error) {
	byID := map[string]*Region{}
	for _, s := range f.Result.Status {
		for _, container := range s.Containers {
			if container.ID == "" || container.Name == "" || s.Name == "" {
				return nil, fmt.Errorf("Status feed contains an unnamed service or region")
			}
			r := byID[container.ID]
			if r == nil {
				r = &Region{ID: container.ID, Name: container.Name, Health: "operational", Services: []Service{}, Events: []Event{}}
				byID[r.ID] = r
			}
			r.Services = append(r.Services, Service{Name: s.Name, Health: health(container.Code), Status: container.Status})
		}
	}
	if len(byID) == 0 {
		return nil, fmt.Errorf("Status feed contains no regions")
	}
	out := make([]Region, 0, len(byID))
	for _, r := range byID {
		// A service without regional containers applies provider-wide.
		for _, s := range f.Result.Status {
			if len(s.Containers) == 0 {
				r.Services = append(r.Services, Service{Name: s.Name, Health: health(s.Code), Status: s.Status})
			}
		}
		for _, s := range r.Services {
			if severity(s.Health) > severity(r.Health) {
				r.Health = s.Health
			}
		}
		for _, group := range []struct {
			kind   string
			events []feedEvent
		}{
			{"incident", f.Result.Incidents},
			{"maintenance", f.Result.Maintenance.Active},
			{"upcoming", f.Result.Maintenance.Upcoming},
		} {
			for _, e := range group.events {
				affected := len(e.Containers) == 0
				for _, container := range e.Containers {
					if container.ID == r.ID {
						affected = true
					}
				}
				if !affected {
					continue
				}
				r.Events = append(r.Events, Event{Name: e.Name, Kind: group.kind, StartsAt: e.StartsAt, EndsAt: e.EndsAt})
				// An active event must not be hidden by a lagging green component.
				if group.kind == "incident" && severity(r.Health) < severity("degraded") {
					r.Health = "degraded"
				}
				if group.kind == "maintenance" && r.Health == "operational" {
					r.Health = "maintenance"
				}
			}
		}
		sort.Slice(r.Services, func(i, j int) bool { return r.Services[i].Name < r.Services[j].Name })
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
