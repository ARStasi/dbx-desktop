package pykernel

import (
	"context"
	"errors"
	"sync"

	"dbx-desktop/internal/nbexec"
)

// Pool keeps one session per open notebook. Runs within one notebook are
// queued; different notebooks run independently.
type Pool struct {
	mu sync.Mutex
	m  map[string]*entry
}

type entry struct {
	turn   chan struct{}
	kernel *Kernel
	// spec identifies what the kernel was started with, such as the profile
	// and environment version; a different spec needs a new session.
	spec   string
	closed bool
}

// NewPool returns an empty pool.
func NewPool() *Pool { return &Pool{m: map[string]*entry{}} }

func (p *Pool) get(key string) *entry {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.m[key]
	if !ok {
		e = &entry{turn: make(chan struct{}, 1)}
		e.turn <- struct{}{}
		p.m[key] = e
	}
	return e
}

// Run executes code in the notebook's session, starting one with start when
// it has none, when its process has exited, or when spec changed.
func (p *Pool) Run(ctx context.Context, key, spec string, start func(context.Context) (*Kernel, error), code string) (nbexec.Output, nbexec.RunInfo, error) {
	var e *entry
	for {
		e = p.get(key)
		select {
		case <-e.turn:
		case <-ctx.Done():
			return cancelled(), nbexec.RunInfo{}, nil
		}
		if !e.closed {
			break
		}
		e.turn <- struct{}{}
	}
	defer func() { e.turn <- struct{}{} }()

	var info nbexec.RunInfo
	if e.kernel != nil && (e.spec != spec || !e.kernel.Alive()) {
		info.Lost = e.spec == spec
		e.kernel.Close()
		e.kernel = nil
	}
	if e.kernel == nil {
		k, err := start(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return cancelled(), info, nil
			}
			return nbexec.Output{}, info, err
		}
		e.kernel, e.spec = k, spec
		info.Started = true
	}
	out, err := e.kernel.Run(ctx, code)
	if errors.Is(err, ErrGone) || !e.kernel.Alive() {
		e.kernel.Close()
		e.kernel = nil
	}
	return out, info, err
}

func cancelled() nbexec.Output {
	o := nbexec.Failed("")
	o.Status = "cancelled"
	return o
}

// Active reports whether a notebook has a live session.
func (p *Pool) Active(key string) bool {
	p.mu.Lock()
	e, ok := p.m[key]
	p.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case <-e.turn:
		defer func() { e.turn <- struct{}{} }()
	default:
		// A run holds the session, so it is live.
		return true
	}
	return e.kernel != nil && e.kernel.Alive()
}

// End stops a notebook's session. It waits for a run in progress to finish,
// so callers cancel that first.
func (p *Pool) End(ctx context.Context, key string) {
	p.mu.Lock()
	e, ok := p.m[key]
	delete(p.m, key)
	p.mu.Unlock()
	if !ok {
		return
	}
	select {
	case <-e.turn:
	case <-ctx.Done():
		return
	}
	if e.kernel != nil {
		e.kernel.Close()
		e.kernel = nil
	}
	e.closed = true
	e.turn <- struct{}{}
}

// EndAll stops every session.
func (p *Pool) EndAll(ctx context.Context) {
	p.mu.Lock()
	keys := make([]string, 0, len(p.m))
	for k := range p.m {
		keys = append(keys, k)
	}
	p.mu.Unlock()
	var wg sync.WaitGroup
	for _, k := range keys {
		wg.Add(1)
		go func(k string) {
			defer wg.Done()
			p.End(ctx, k)
		}(k)
	}
	wg.Wait()
}

// Rename moves a session to a new key, after its notebook file moved.
func (p *Pool) Rename(oldKey, newKey string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, taken := p.m[newKey]; taken {
		return
	}
	if e, ok := p.m[oldKey]; ok {
		delete(p.m, oldKey)
		p.m[newKey] = e
	}
}
