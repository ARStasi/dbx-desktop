package main

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/databricks/databricks-sdk-go/service/iam"
	"github.com/databricks/databricks-sdk-go/service/jobs"
	"github.com/databricks/databricks-sdk-go/service/sql"

	"dbx-desktop/internal/dbcfg"
	"dbx-desktop/internal/dbcli"
	"dbx-desktop/internal/settings"
)

// Palette is the set of colors a workspace can be tagged with. A workspace
// with no saved color gets one of these, chosen from its profile name.
var Palette = []string{
	"#FF3621", // lava
	"#00A972", // green
	"#2272B4", // blue
	"#FFAB00", // amber
	"#8C5CD9", // violet
	"#0FA3B1", // teal
	"#E05C9C", // pink
	"#7A8B93", // slate
}

const (
	overviewTimeout = 30 * time.Second
	maxRunsChecked  = 300
)

// Workspace is a config profile joined with the app's metadata for it.
type Workspace struct {
	Profile dbcfg.Profile          `json:"profile"`
	Meta    settings.WorkspaceMeta `json:"meta"`
	Active  bool                   `json:"active"`
}

// AppStatus is what the UI needs before it can do anything else.
type AppStatus struct {
	CLI        dbcli.Info `json:"cli"`
	ConfigPath string     `json:"configPath"`
	Palette    []string   `json:"palette"`
}

// FailedRun is a job run that ended badly.
type FailedRun struct {
	RunID   int64  `json:"runId"`
	Name    string `json:"name"`
	State   string `json:"state"`
	Message string `json:"message"`
	EndTime int64  `json:"endTime"`
	URL     string `json:"url"`
}

// Warehouse is a SQL warehouse and its current state.
type Warehouse struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	State      string `json:"state"`
	Size       string `json:"size"`
	Serverless bool   `json:"serverless"`
}

// Overview is the launch-screen summary for one workspace. Each section
// carries its own error so one failing call does not blank the screen.
type Overview struct {
	Profile string `json:"profile"`
	User    string `json:"user"`
	// AuthError is set when the workspace could not be reached or rejected
	// the credentials. The other sections are empty in that case.
	AuthError string `json:"authError"`

	FailedRuns    []FailedRun `json:"failedRuns"`
	RunsChecked   int         `json:"runsChecked"`
	RunsTruncated bool        `json:"runsTruncated"`
	RunsError     string      `json:"runsError"`

	Warehouses      []Warehouse `json:"warehouses"`
	WarehousesError string      `json:"warehousesError"`

	FetchedAt int64 `json:"fetchedAt"`
}

// WorkspaceService backs the workspace hub: the profile manager, login, the
// workspace switcher and the overview.
type WorkspaceService struct {
	cfgPath string
	store   *settings.Store

	pool *clientPool

	mu          sync.Mutex
	cli         *dbcli.Info
	cancelLogin context.CancelFunc
}

// NewWorkspaceService resolves the config and settings locations.
func NewWorkspaceService() (*WorkspaceService, error) {
	cfgPath, err := dbcfg.Path()
	if err != nil {
		return nil, err
	}
	settingsPath, err := settings.DefaultPath()
	if err != nil {
		return nil, err
	}
	s := &WorkspaceService{
		cfgPath: cfgPath,
		store:   settings.New(settingsPath),
	}
	s.pool = newClientPool(cfgPath, func() string {
		if cli := s.cliInfo(false); cli.Found {
			return cli.Path
		}
		return ""
	})
	return s, nil
}

// Status reports whether the Databricks CLI is installed and where the config
// file lives. Pass refresh to look for the CLI again after installing it.
func (s *WorkspaceService) Status(refresh bool) AppStatus {
	return AppStatus{CLI: s.cliInfo(refresh), ConfigPath: s.cfgPath, Palette: Palette}
}

func (s *WorkspaceService) cliInfo(refresh bool) dbcli.Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cli == nil || refresh {
		info := dbcli.Detect(context.Background())
		s.cli = &info
	}
	return *s.cli
}

// ListWorkspaces returns every profile in the config file with its metadata.
// Exactly one workspace profile is marked active when any exist.
func (s *WorkspaceService) ListWorkspaces() ([]Workspace, error) {
	profiles, err := dbcfg.List(s.cfgPath)
	if err != nil {
		return nil, err
	}
	active, metas, err := s.store.Snapshot()
	if err != nil {
		return nil, err
	}
	active = resolveActive(active, profiles)

	out := make([]Workspace, 0, len(profiles))
	for _, p := range profiles {
		m := metas[p.Name]
		if m.Color == "" {
			m.Color = defaultColor(p.Name)
		}
		out = append(out, Workspace{Profile: p, Meta: m, Active: p.Name == active})
	}
	return out, nil
}

// resolveActive picks the active workspace: the saved one if it still exists,
// else the CLI's default profile, else the first workspace profile.
func resolveActive(saved string, profiles []dbcfg.Profile) string {
	var def, first string
	for _, p := range profiles {
		if p.IsAccount {
			continue
		}
		if p.Name == saved {
			return saved
		}
		if p.IsDefault {
			def = p.Name
		}
		if first == "" {
			first = p.Name
		}
	}
	if def != "" {
		return def
	}
	return first
}

func defaultColor(name string) string {
	h := fnv.New32a()
	h.Write([]byte(name))
	return Palette[int(h.Sum32())%len(Palette)]
}

// SuggestProfileName normalizes a pasted workspace URL and proposes a profile
// name for it that is not already taken.
func (s *WorkspaceService) SuggestProfileName(rawHost string) (string, error) {
	host, err := dbcfg.NormalizeHost(rawHost)
	if err != nil {
		return "", err
	}
	base := dbcfg.SuggestName(host)
	name := base
	for i := 2; ; i++ {
		exists, err := dbcfg.Exists(s.cfgPath, name)
		if err != nil {
			return "", err
		}
		if !exists {
			return name, nil
		}
		name = fmt.Sprintf("%s-%d", base, i)
	}
}

// AddWorkspaceOAuth signs in to a workspace in the browser and saves it as a
// new profile. It blocks until sign-in finishes, fails, or is cancelled.
func (s *WorkspaceService) AddWorkspaceOAuth(rawHost, profile string) error {
	host, err := s.checkNewProfile(rawHost, profile)
	if err != nil {
		return err
	}
	if err := s.login(host, profile); err != nil {
		return err
	}
	return s.store.SetActive(profile)
}

// AddWorkspaceToken saves a workspace that authenticates with a personal
// access token. The token is written to the config file in plain text.
func (s *WorkspaceService) AddWorkspaceToken(rawHost, profile, token string) error {
	host, err := s.checkNewProfile(rawHost, profile)
	if err != nil {
		return err
	}
	if err := dbcfg.SaveTokenProfile(s.cfgPath, profile, host, token); err != nil {
		return err
	}
	s.pool.drop(profile)
	return s.store.SetActive(profile)
}

func (s *WorkspaceService) checkNewProfile(rawHost, profile string) (string, error) {
	host, err := dbcfg.NormalizeHost(rawHost)
	if err != nil {
		return "", err
	}
	if err := dbcfg.ValidateName(profile); err != nil {
		return "", err
	}
	exists, err := dbcfg.Exists(s.cfgPath, profile)
	if err != nil {
		return "", err
	}
	if exists {
		return "", fmt.Errorf("a profile named %q already exists", profile)
	}
	return host, nil
}

// Reauthenticate runs the browser sign-in again for an existing profile, for
// example after its session expired.
func (s *WorkspaceService) Reauthenticate(profile string) error {
	p, err := s.profile(profile)
	if err != nil {
		return err
	}
	return s.login(p.Host, profile)
}

// SwitchToOAuth replaces a profile's stored token with browser sign-in. The
// token is removed from the config file only after sign-in succeeds.
func (s *WorkspaceService) SwitchToOAuth(profile string) error {
	p, err := s.profile(profile)
	if err != nil {
		return err
	}
	if !p.HasToken {
		return fmt.Errorf("profile %q has no stored token", profile)
	}
	if err := s.login(p.Host, profile); err != nil {
		return err
	}
	if err := dbcfg.MarkOAuth(s.cfgPath, profile); err != nil {
		return err
	}
	s.pool.drop(profile)
	return nil
}

func (s *WorkspaceService) login(host, profile string) error {
	cli := s.cliInfo(false)
	if !cli.Found {
		return errors.New("the Databricks CLI is not installed, so browser sign-in is unavailable")
	}
	if cli.Legacy {
		return fmt.Errorf("Databricks CLI %s is too old for browser sign-in; install the current CLI", cli.Version)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	s.mu.Lock()
	if s.cancelLogin != nil {
		s.mu.Unlock()
		cancel()
		return errors.New("another sign-in is already in progress")
	}
	s.cancelLogin = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.cancelLogin = nil
		s.mu.Unlock()
		cancel()
	}()

	if err := dbcli.Login(ctx, cli.Path, s.cfgPath, host, profile); err != nil {
		return err
	}
	s.pool.drop(profile)
	return nil
}

// CancelLogin abandons a browser sign-in that is still waiting.
func (s *WorkspaceService) CancelLogin() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancelLogin != nil {
		s.cancelLogin()
	}
}

// RemoveWorkspace deletes a profile from the config file and forgets the
// app's metadata for it. The previous file is kept as .databrickscfg.bak.
func (s *WorkspaceService) RemoveWorkspace(profile string) error {
	if err := dbcfg.Remove(s.cfgPath, profile); err != nil {
		return err
	}
	s.pool.drop(profile)
	return s.store.Forget(profile)
}

// UpdateMeta saves the nickname, color, production flag and default volume.
func (s *WorkspaceService) UpdateMeta(profile string, meta settings.WorkspaceMeta) error {
	if _, err := s.profile(profile); err != nil {
		return err
	}
	meta.Nickname = strings.TrimSpace(meta.Nickname)
	meta.DefaultVolume = strings.TrimSpace(meta.DefaultVolume)
	return s.store.SetMeta(profile, meta)
}

// SetActive switches the active workspace.
func (s *WorkspaceService) SetActive(profile string) error {
	p, err := s.profile(profile)
	if err != nil {
		return err
	}
	if p.IsAccount {
		return fmt.Errorf("%q is an account profile, not a workspace", profile)
	}
	return s.store.SetActive(profile)
}

// SetDefaultProfile sets the profile the CLI uses when none is named.
func (s *WorkspaceService) SetDefaultProfile(profile string) error {
	return dbcfg.SetDefault(s.cfgPath, profile)
}

func (s *WorkspaceService) profile(name string) (dbcfg.Profile, error) {
	profiles, err := dbcfg.List(s.cfgPath)
	if err != nil {
		return dbcfg.Profile{}, err
	}
	for _, p := range profiles {
		if p.Name == name {
			return p, nil
		}
	}
	return dbcfg.Profile{}, fmt.Errorf("profile %q not found", name)
}

// Overview fetches the launch-screen summary for a workspace: who you are
// signed in as, runs that failed in the past 24 hours, and warehouse states.
func (s *WorkspaceService) Overview(profile string) (Overview, error) {
	o := Overview{
		Profile:    profile,
		FailedRuns: []FailedRun{},
		Warehouses: []Warehouse{},
		FetchedAt:  time.Now().UnixMilli(),
	}
	p, err := s.profile(profile)
	if err != nil {
		return o, err
	}
	if p.IsAccount {
		return o, fmt.Errorf("%q is an account profile, not a workspace", profile)
	}
	ctx, cancel := context.WithTimeout(context.Background(), overviewTimeout)
	defer cancel()

	w, err := s.pool.get(profile)
	if err != nil {
		o.AuthError = cleanErr(err)
		return o, nil
	}
	me, err := w.me.Me(ctx, iam.MeRequest{})
	if err != nil {
		// A cached client can hold stale credentials after a re-login.
		s.pool.drop(profile)
		o.AuthError = cleanErr(err)
		return o, nil
	}
	o.User = me.UserName

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		var rerr error
		o.FailedRuns, o.RunsChecked, o.RunsTruncated, rerr = failedRuns(ctx, w)
		if rerr != nil {
			o.RunsError = cleanErr(rerr)
		}
	}()
	go func() {
		defer wg.Done()
		var werr error
		o.Warehouses, werr = warehouses(ctx, w)
		if werr != nil {
			o.WarehousesError = cleanErr(werr)
		}
	}()
	wg.Wait()
	return o, nil
}

func failedRuns(ctx context.Context, w *apiClients) ([]FailedRun, int, bool, error) {
	failed := []FailedRun{}
	checked := 0
	it := w.jobs.ListRuns(ctx, jobs.ListRunsRequest{
		CompletedOnly: true,
		StartTimeFrom: time.Now().Add(-24 * time.Hour).UnixMilli(),
		Limit:         25,
	})
	for it.HasNext(ctx) {
		if checked >= maxRunsChecked {
			return failed, checked, true, nil
		}
		r, err := it.Next(ctx)
		if err != nil {
			return failed, checked, false, err
		}
		checked++
		if r.State == nil || !isFailure(r.State) {
			continue
		}
		state := string(r.State.ResultState)
		if state == "" {
			state = string(r.State.LifeCycleState)
		}
		name := r.RunName
		if name == "" {
			name = fmt.Sprintf("Run %d", r.RunId)
		}
		failed = append(failed, FailedRun{
			RunID:   r.RunId,
			Name:    name,
			State:   state,
			Message: r.State.StateMessage,
			EndTime: r.EndTime,
			URL:     r.RunPageUrl,
		})
	}
	return failed, checked, false, nil
}

func isFailure(st *jobs.RunState) bool {
	switch st.ResultState {
	case jobs.RunResultStateFailed, jobs.RunResultStateTimedout, jobs.RunResultStateUpstreamFailed:
		return true
	}
	return string(st.LifeCycleState) == "INTERNAL_ERROR"
}

func warehouses(ctx context.Context, w *apiClients) ([]Warehouse, error) {
	list, err := w.warehouses.ListAll(ctx, sql.ListWarehousesRequest{})
	if err != nil {
		return []Warehouse{}, err
	}
	out := make([]Warehouse, 0, len(list))
	for _, e := range list {
		out = append(out, Warehouse{
			ID:         e.Id,
			Name:       e.Name,
			State:      string(e.State),
			Size:       e.ClusterSize,
			Serverless: e.EnableServerlessCompute,
		})
	}
	// Running first, then by name.
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := stateRank(out[i].State), stateRank(out[j].State)
		if ri != rj {
			return ri < rj
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

func stateRank(state string) int {
	switch state {
	case "RUNNING":
		return 0
	case "STARTING", "STOPPING":
		return 1
	}
	return 2
}

// cleanErr trims SDK errors to one readable line.
func cleanErr(err error) string {
	msg := strings.TrimSpace(err.Error())
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "refresh token is invalid") || strings.Contains(lower, "databricks auth login") {
		return "The saved sign-in for this workspace has expired."
	}
	if strings.Contains(lower, "no such host") {
		return "The workspace host could not be found. Check the URL and your network connection."
	}
	if i := strings.Index(msg, "\n"); i > 0 {
		msg = msg[:i]
	}
	if len(msg) > 400 {
		msg = msg[:400] + "…"
	}
	return msg
}
