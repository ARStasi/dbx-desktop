package nbexec

import (
	"context"
	"errors"
	"sync"
)

// Sessions keeps one execution context per open notebook, so cells run in the
// same notebook share variables. Runs within one notebook are queued, as in a
// Databricks notebook; different notebooks run independently.
type Sessions struct {
	mu sync.Mutex
	m  map[string]*session
}

type session struct {
	// turn holds one token; a run takes it for its whole duration.
	turn      chan struct{}
	clusterID string
	contextID string
	api       Doer
	// closed is set once End removed the session; a run that was waiting
	// for it starts over with a fresh one.
	closed bool
}

// NewSessions returns an empty session table.
func NewSessions() *Sessions { return &Sessions{m: map[string]*session{}} }

// RunInfo says what happened to the session during a run.
type RunInfo struct {
	// Started is true when the run had to start a new Python session, so
	// earlier variables are not defined.
	Started bool `json:"started"`
	// Lost is true when the notebook had a session that ended on the cluster,
	// for example after a restart.
	Lost bool `json:"lost"`
}

func (s *Sessions) get(key string) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	ss, ok := s.m[key]
	if !ok {
		ss = &session{turn: make(chan struct{}, 1)}
		ss.turn <- struct{}{}
		s.m[key] = ss
	}
	return ss
}

// Run executes code for the notebook identified by key on clusterID. It
// starts a context when the notebook has none, or has one on another cluster.
// When the context turns out to be gone it starts a new one and reports Lost;
// the code had not run, so running it in the new context runs it once.
func (s *Sessions) Run(ctx context.Context, api Doer, key, clusterID, code string) (Output, RunInfo, error) {
	var ss *session
	for {
		ss = s.get(key)
		select {
		case <-ss.turn:
		case <-ctx.Done():
			return newOutput("cancelled"), RunInfo{}, nil
		}
		if !ss.closed {
			break
		}
		ss.turn <- struct{}{}
	}
	defer func() { ss.turn <- struct{}{} }()

	var info RunInfo
	if ss.contextID != "" && ss.clusterID != clusterID {
		DestroyContext(context.Background(), ss.api, ss.clusterID, ss.contextID)
		ss.contextID = ""
	}
	for attempt := 0; ; attempt++ {
		if ss.contextID == "" {
			id, err := CreateContext(ctx, api, clusterID)
			if err != nil {
				if ctx.Err() != nil {
					return newOutput("cancelled"), info, nil
				}
				return Output{}, info, err
			}
			ss.clusterID, ss.contextID, ss.api = clusterID, id, api
			info.Started = true
		}
		out, err := Run(ctx, api, clusterID, ss.contextID, code)
		if errors.Is(err, ErrContextGone) && attempt == 0 {
			ss.contextID = ""
			info.Lost = true
			continue
		}
		if errors.Is(err, ErrContextGone) {
			ss.contextID = ""
		}
		return out, info, err
	}
}

// Active reports the cluster a notebook's session runs on, or "" when it has
// none.
func (s *Sessions) Active(key string) string {
	s.mu.Lock()
	ss, ok := s.m[key]
	s.mu.Unlock()
	if !ok {
		return ""
	}
	// A run in progress holds the token; report what it last used.
	select {
	case <-ss.turn:
		defer func() { ss.turn <- struct{}{} }()
	default:
	}
	if ss.contextID == "" {
		return ""
	}
	return ss.clusterID
}

// End destroys a notebook's session, if it has one. It waits for a run in
// progress to finish, so callers cancel that first.
func (s *Sessions) End(ctx context.Context, key string) {
	s.mu.Lock()
	ss, ok := s.m[key]
	delete(s.m, key)
	s.mu.Unlock()
	if !ok {
		return
	}
	select {
	case <-ss.turn:
	case <-ctx.Done():
		return
	}
	if ss.contextID != "" {
		DestroyContext(ctx, ss.api, ss.clusterID, ss.contextID)
	}
	ss.contextID, ss.closed = "", true
	ss.turn <- struct{}{}
}

// EndMatching ends every session whose key match accepts.
func (s *Sessions) EndMatching(ctx context.Context, match func(key string) bool) {
	s.mu.Lock()
	keys := []string{}
	for k := range s.m {
		if match(k) {
			keys = append(keys, k)
		}
	}
	s.mu.Unlock()
	var wg sync.WaitGroup
	for _, k := range keys {
		wg.Add(1)
		go func(k string) {
			defer wg.Done()
			s.End(ctx, k)
		}(k)
	}
	wg.Wait()
}

// Rename moves a session to a new key, after its notebook file moved.
func (s *Sessions) Rename(oldKey, newKey string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, taken := s.m[newKey]; taken {
		return
	}
	if ss, ok := s.m[oldKey]; ok {
		delete(s.m, oldKey)
		s.m[newKey] = ss
	}
}
