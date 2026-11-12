package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/databricks/databricks-sdk-go/service/compute"
	"github.com/databricks/databricks-sdk-go/service/iam"
	"github.com/databricks/databricks-sdk-go/service/workspace"
	"github.com/wailsapp/wails/v3/pkg/application"

	"dbx-desktop/internal/nbexec"
	"dbx-desktop/internal/pykernel"
	"dbx-desktop/internal/queries"
	"dbx-desktop/internal/settings"
	"dbx-desktop/internal/wsfiles"
)

// notebookHeader starts every notebook in Databricks source format.
const notebookHeader = "# Databricks notebook source\n"

// NotebookTab is an open notebook file with its content.
type NotebookTab struct {
	File    queries.File `json:"file"`
	Content string       `json:"content"`
	// Remote is set when the file is the local copy of a workspace notebook.
	Remote *RemoteFile `json:"remote,omitempty"`
}

// ServerlessID is the compute choice for serverless, in place of a cluster ID.
const ServerlessID = "serverless"

// NotebookViewState is what the notebook view restores when it opens.
type NotebookViewState struct {
	// Dir is the folder new notebooks are created in for this workspace.
	Dir string `json:"dir"`
	// ClusterID is the chosen compute: a cluster ID, or "serverless".
	ClusterID string `json:"clusterId"`
	// ServerlessVersion is the serverless environment version to use.
	ServerlessVersion int           `json:"serverlessVersion"`
	Tabs              []NotebookTab `json:"tabs"`
	ActiveTab         string        `json:"activeTab"`
	// Trash is true when deleted notebooks go to the system trash.
	Trash bool `json:"trash"`
	// Sessions maps each open notebook with a live Python session to the
	// cluster it runs on, or "serverless". Sessions outlive the view, so they survive
	// switching views or workspaces until the app quits.
	Sessions map[string]string `json:"sessions"`
}

// Cluster is an all-purpose cluster notebooks can run on.
type Cluster struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	State        string `json:"state"`
	StateMessage string `json:"stateMessage"`
	// Runtime is the Databricks Runtime version key, such as 15.4.x-scala2.12.
	Runtime string `json:"runtime"`
	// AccessMode is the data_security_mode, such as USER_ISOLATION.
	AccessMode string `json:"accessMode"`
	// SingleUser is who a dedicated cluster is assigned to.
	SingleUser string `json:"singleUser"`
	Creator    string `json:"creator"`
	// Workers describes the size, such as "2–8 workers" or "Single node".
	Workers string `json:"workers"`
	// AutoStopMinutes is the inactivity timeout, 0 when it never stops.
	AutoStopMinutes int `json:"autoStopMinutes"`
}

// CellRun is the result of running one cell.
type CellRun struct {
	Output nbexec.Output `json:"output"`
	// Started is true when this run began a new Python session.
	Started bool `json:"started"`
	// Lost is true when the notebook's previous session had ended on the
	// cluster, so variables from earlier cells are gone.
	Lost bool `json:"lost"`
	// NotRunning is set when the cluster is not running, with its state.
	NotRunning string `json:"notRunning"`
	// NeedsSetup is set when serverless was chosen but its local Python
	// environment is not set up yet.
	NeedsSetup bool `json:"needsSetup"`
}

// NotebookService backs the notebook view: notebook files, running cells on
// all-purpose clusters, and workspace notebooks.
type NotebookService struct {
	pool      *clientPool
	store     *settings.Store
	mirrorDir string
	sessions  *nbexec.Sessions
	// kernels hold serverless sessions: local Python with Databricks Connect.
	kernels *pykernel.Pool
	// pyRoot holds the local Python environments for serverless.
	pyRoot string

	mu      sync.Mutex
	running map[string]context.CancelFunc
	mirrors map[string]*wsfiles.Mirror
}

// NewNotebookService shares the workspace service's clients and settings.
func NewNotebookService(ws *WorkspaceService) (*NotebookService, error) {
	settingsPath, err := settings.DefaultPath()
	if err != nil {
		return nil, err
	}
	return &NotebookService{
		pool:      ws.pool,
		store:     ws.store,
		mirrorDir: filepath.Join(filepath.Dir(settingsPath), "notebooks"),
		sessions:  nbexec.NewSessions(),
		kernels:   pykernel.NewPool(),
		pyRoot:    filepath.Join(filepath.Dir(settingsPath), "python"),
		running:   map[string]context.CancelFunc{},
		mirrors:   map[string]*wsfiles.Mirror{},
	}, nil
}

// ServiceShutdown ends every Python session when the app quits, so contexts
// are not left behind on clusters.
func (s *NotebookService) ServiceShutdown() error {
	s.mu.Lock()
	for _, cancel := range s.running {
		cancel()
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.kernels.EndAll(ctx)
	}()
	s.sessions.EndMatching(ctx, func(string) bool { return true })
	wg.Wait()
	return nil
}

func sessionKey(profile, notebookPath string) string {
	return profile + "\x00" + filepath.Clean(notebookPath)
}

func (s *NotebookService) dir(profile string) (string, error) {
	_, root, err := s.store.Notebooks(profile)
	if err != nil {
		return "", err
	}
	if root == "" {
		if root, err = queries.DefaultRoot(); err != nil {
			return "", err
		}
	}
	return filepath.Join(queries.Dir(root, profile), "notebooks"), nil
}

func (s *NotebookService) mirror(profile string) *wsfiles.Mirror {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.mirrors[profile]
	if !ok {
		m = wsfiles.NewNotebooks(queries.Dir(s.mirrorDir, profile))
		s.mirrors[profile] = m
	}
	return m
}

func (s *NotebookService) remoteInfo(profile, localPath, content string) *RemoteFile {
	l, ok, err := s.mirror(profile).Lookup(localPath)
	if err != nil || !ok {
		return nil
	}
	return &RemoteFile{Path: l.RemotePath, ModifiedAt: l.ModifiedAt, Unsaved: wsfiles.Hash(content) != l.Hash}
}

// ---------- Notebook files ----------

// State returns the saved notebook view state for a workspace. Tabs whose
// files no longer exist are dropped.
func (s *NotebookService) State(profile string) (NotebookViewState, error) {
	out := NotebookViewState{Tabs: []NotebookTab{}, Sessions: map[string]string{}}
	st, _, err := s.store.Notebooks(profile)
	if err != nil {
		return out, err
	}
	if out.Dir, err = s.dir(profile); err != nil {
		return out, err
	}
	out.ClusterID = st.ClusterID
	out.ServerlessVersion = st.ServerlessVersion
	if !pykernel.Supported(out.ServerlessVersion) {
		out.ServerlessVersion = pykernel.DefaultVersion
	}
	out.Trash = queries.HasTrash()
	for _, p := range st.Tabs {
		tab, err := s.OpenNotebook(p)
		if err != nil {
			continue
		}
		tab.Remote = s.remoteInfo(profile, p, tab.Content)
		out.Tabs = append(out.Tabs, tab)
		if p == st.ActiveTab {
			out.ActiveTab = p
		}
		if c := s.sessions.Active(sessionKey(profile, p)); c != "" {
			out.Sessions[p] = c
		} else if s.kernels.Active(sessionKey(profile, p)) {
			out.Sessions[p] = ServerlessID
		}
	}
	return out, nil
}

// SaveState remembers the chosen compute and which notebooks are open.
func (s *NotebookService) SaveState(profile, clusterID string, serverlessVersion int, tabs []string, activeTab string) error {
	if tabs == nil {
		tabs = []string{}
	}
	return s.store.SetNotebooks(profile, settings.NotebookState{
		ClusterID:         clusterID,
		ServerlessVersion: serverlessVersion,
		Tabs:              tabs,
		ActiveTab:         activeTab,
	})
}

// NewNotebook creates Untitled-N.py, an empty Python notebook, in the
// workspace's notebook folder.
func (s *NotebookService) NewNotebook(profile string) (NotebookTab, error) {
	dir, err := s.dir(profile)
	if err != nil {
		return NotebookTab{}, err
	}
	f, err := queries.NewUntitledExt(dir, queries.Notebook, notebookHeader)
	return NotebookTab{File: f, Content: notebookHeader}, cleanFileErr(err)
}

// ListNotebooks lists the notebooks in the workspace's folder, newest first.
func (s *NotebookService) ListNotebooks(profile string) ([]queries.File, error) {
	dir, err := s.dir(profile)
	if err != nil {
		return nil, err
	}
	return queries.ListExt(dir, queries.Notebook)
}

// OpenNotebook reads a .py notebook from anywhere on disk.
func (s *NotebookService) OpenNotebook(p string) (NotebookTab, error) {
	content, err := queries.ReadExt(p, queries.Notebook)
	if err != nil {
		return NotebookTab{}, cleanFileErr(err)
	}
	st, err := os.Stat(p)
	if err != nil {
		return NotebookTab{}, cleanFileErr(err)
	}
	return NotebookTab{
		File:    queries.File{Path: p, Name: filepath.Base(p), Modified: st.ModTime().UnixMilli()},
		Content: content,
	}, nil
}

// OpenNotebookWithLink reads a notebook and says whether it is the local copy
// of a workspace notebook.
func (s *NotebookService) OpenNotebookWithLink(profile, p string) (NotebookTab, error) {
	tab, err := s.OpenNotebook(p)
	if err != nil {
		return tab, err
	}
	tab.Remote = s.remoteInfo(profile, p, tab.Content)
	return tab, nil
}

// WriteNotebook saves a notebook's source to its file.
func (s *NotebookService) WriteNotebook(p, content string) error {
	return cleanFileErr(queries.WriteExt(p, queries.Notebook, content))
}

// RenameNotebook renames a notebook file within its folder. Its Python
// session, if any, moves with it.
func (s *NotebookService) RenameNotebook(profile, p, newName string) (queries.File, error) {
	f, err := queries.RenameExt(p, queries.Notebook, newName)
	if err != nil {
		return f, cleanFileErr(err)
	}
	s.sessions.Rename(sessionKey(profile, p), sessionKey(profile, f.Path))
	s.kernels.Rename(sessionKey(profile, p), sessionKey(profile, f.Path))
	return f, nil
}

// DeleteNotebooks moves notebooks in the workspace's notebook folder to the
// trash, or removes them where there is none, and ends their sessions.
func (s *NotebookService) DeleteNotebooks(profile string, paths []string) (DeleteResult, error) {
	out := DeleteResult{Deleted: []string{}, Errors: []string{}}
	dir, err := s.dir(profile)
	if err != nil {
		return out, err
	}
	for _, p := range paths {
		if err := queries.DeleteExt(dir, p, queries.Notebook); err != nil {
			out.Errors = append(out.Errors, cleanFileErr(err).Error())
			continue
		}
		go s.EndSession(profile, p)
		out.Deleted = append(out.Deleted, p)
	}
	return out, nil
}

// PickNotebook shows the native open dialog for a .py notebook. It returns
// an empty path when the user cancels.
func (s *NotebookService) PickNotebook() (string, error) {
	app := application.Get()
	if app == nil {
		return "", errors.New("the file dialog is not available")
	}
	return app.Dialog.OpenFile().
		SetTitle("Open notebook").
		AddFilter("Python notebooks", "*.py").
		CanChooseFiles(true).
		PromptForSingleSelection()
}

// ---------- Clusters ----------

// ListClusters returns the all-purpose clusters in the workspace, running
// ones first. Job and pipeline clusters are left out, since cells cannot run
// on them.
func (s *NotebookService) ListClusters(profile string) ([]Cluster, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return nil, remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	list, err := c.clusters.ListAll(ctx, compute.ListClustersRequest{
		FilterBy: &compute.ListClustersFilterBy{
			ClusterSources: []compute.ClusterSource{compute.ClusterSourceUi, compute.ClusterSourceApi},
		},
	})
	if err != nil {
		return nil, remoteErr(err)
	}
	out := make([]Cluster, 0, len(list))
	for _, d := range list {
		if d.ClusterSource != "" && d.ClusterSource != compute.ClusterSourceUi && d.ClusterSource != compute.ClusterSourceApi {
			continue
		}
		out = append(out, toCluster(d))
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := clusterRank(out[i].State), clusterRank(out[j].State)
		if ri != rj {
			return ri < rj
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

func toCluster(d compute.ClusterDetails) Cluster {
	cl := Cluster{
		ID:              d.ClusterId,
		Name:            d.ClusterName,
		State:           string(d.State),
		StateMessage:    d.StateMessage,
		Runtime:         d.SparkVersion,
		AccessMode:      string(d.DataSecurityMode),
		SingleUser:      d.SingleUserName,
		Creator:         d.CreatorUserName,
		AutoStopMinutes: d.AutoterminationMinutes,
	}
	switch {
	case d.Autoscale != nil:
		cl.Workers = fmt.Sprintf("%d–%d workers", d.Autoscale.MinWorkers, d.Autoscale.MaxWorkers)
	case d.NumWorkers == 0:
		cl.Workers = "Single node"
	case d.NumWorkers == 1:
		cl.Workers = "1 worker"
	default:
		cl.Workers = fmt.Sprintf("%d workers", d.NumWorkers)
	}
	return cl
}

func clusterRank(state string) int {
	switch state {
	case "RUNNING", "RESIZING":
		return 0
	case "PENDING", "RESTARTING":
		return 1
	default:
		return 2
	}
}

// StartCluster asks a terminated cluster to start. It returns once the
// request is accepted, not when the cluster is running.
func (s *NotebookService) StartCluster(profile, id string) error {
	c, err := s.pool.get(profile)
	if err != nil {
		return remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	if _, err := c.clusters.Start(ctx, compute.StartCluster{ClusterId: id}); err != nil {
		return remoteErr(err)
	}
	return nil
}

// ---------- Running cells ----------

// RunCell runs Python code in the notebook's session on a cluster, starting a
// session when there is none. runID is chosen by the caller so it can cancel
// the run with CancelCell.
func (s *NotebookService) RunCell(profile, clusterID string, serverlessVersion int, notebookPath, code, runID string) CellRun {
	if strings.TrimSpace(code) == "" {
		return CellRun{Output: nbexec.Failed("The cell is empty.")}
	}
	if clusterID == "" {
		return CellRun{Output: nbexec.Failed("Choose a cluster first.")}
	}
	if clusterID == ServerlessID {
		return s.runServerless(profile, serverlessVersion, notebookPath, code, runID)
	}
	c, err := s.pool.get(profile)
	if err != nil {
		return CellRun{Output: nbexec.Failed(cleanErr(err))}
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.running[runID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, runID)
		s.mu.Unlock()
		cancel()
	}()

	// The Command Execution API needs a running cluster; say so plainly
	// instead of letting the context request fail.
	gctx, gcancel := context.WithTimeout(ctx, browseTimeout)
	d, err := c.clusters.GetByClusterId(gctx, clusterID)
	gcancel()
	if err != nil {
		if ctx.Err() != nil {
			return CellRun{Output: nbexec.Output{Status: "cancelled", Kind: "none"}}
		}
		return CellRun{Output: nbexec.Failed(cleanErr(err))}
	}
	if d.State != compute.StateRunning && d.State != compute.StateResizing {
		out := nbexec.Failed(fmt.Sprintf("%s is %s. Start it to run cells.", d.ClusterName, strings.ToLower(string(d.State))))
		return CellRun{Output: out, NotRunning: string(d.State)}
	}

	// A notebook runs on one compute at a time; leaving serverless ends its session.
	s.kernels.End(ctx, sessionKey(profile, notebookPath))
	out, info, err := s.sessions.Run(ctx, c.api, sessionKey(profile, notebookPath), clusterID, code)
	if err != nil {
		return CellRun{Output: nbexec.Failed(cleanErr(err)), Started: info.Started, Lost: info.Lost}
	}
	return CellRun{Output: out, Started: info.Started, Lost: info.Lost}
}

// CancelCell cancels a running cell started with the same runID. A cell
// waiting behind another in the same notebook is dropped without running.
func (s *NotebookService) CancelCell(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cancel, ok := s.running[runID]; ok {
		cancel()
	}
}

// EndSession ends a notebook's Python session on its cluster, clearing its
// variables. The next cell run starts a new one.
func (s *NotebookService) EndSession(profile, notebookPath string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.kernels.End(ctx, sessionKey(profile, notebookPath))
	}()
	s.sessions.End(ctx, sessionKey(profile, notebookPath))
	wg.Wait()
}

// ---------- Workspace notebooks ----------

// NotebookPlaces returns the user's home folder, the last folder a notebook
// was saved to and the workspace notebooks recently used from this computer.
func (s *NotebookService) NotebookPlaces(profile string) (WorkspacePlaces, error) {
	out := WorkspacePlaces{Recent: []RecentWorkspaceFile{}}
	c, err := s.pool.get(profile)
	if err != nil {
		return out, remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	me, err := c.me.Me(ctx, iam.MeRequest{})
	if err != nil {
		return out, remoteErr(err)
	}
	out.Home = "/Users/" + me.UserName
	m := s.mirror(profile)
	if out.LastFolder, _ = m.LastFolder(); out.LastFolder == "" {
		out.LastFolder = out.Home
	}
	links, err := m.Recent()
	if err != nil {
		return out, err
	}
	for _, l := range links {
		r := RecentWorkspaceFile{Path: l.RemotePath, Name: path.Base(l.RemotePath), Opened: l.Opened}
		if local, err := m.LocalPath(l.RemotePath); err == nil {
			if content, err := queries.ReadExt(local, queries.Notebook); err == nil {
				r.Unsaved = wsfiles.Hash(content) != l.Hash
			}
		}
		out.Recent = append(out.Recent, r)
	}
	return out, nil
}

// ListNotebookFolder lists the folders, Git folders and Python notebooks in a
// workspace folder: folders first, then notebooks, each sorted by name.
// Notebooks are reported with kind "file".
func (s *NotebookService) ListNotebookFolder(profile, folder string) ([]WorkspaceItem, error) {
	folder, err := wsfiles.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	c, err := s.pool.get(profile)
	if err != nil {
		return nil, remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	list, err := c.workspace.ListAll(ctx, workspace.ListWorkspaceRequest{Path: folder})
	if err != nil {
		if isMissing(err) {
			return nil, fmt.Errorf("%s does not exist in this workspace", folder)
		}
		return nil, remoteErr(err)
	}
	out := []WorkspaceItem{}
	for _, o := range list {
		item := WorkspaceItem{Path: o.Path, Name: path.Base(o.Path), Modified: o.ModifiedAt}
		if strings.HasPrefix(item.Name, ".") {
			continue
		}
		switch o.ObjectType {
		case workspace.ObjectTypeDirectory:
			item.Kind = "folder"
		case workspace.ObjectTypeRepo:
			item.Kind = "repo"
		case workspace.ObjectTypeNotebook:
			if o.Language != workspace.LanguagePython {
				continue
			}
			item.Kind = "file"
		default:
			continue
		}
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].Kind == "file") != (out[j].Kind == "file") {
			return out[j].Kind == "file"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// NotebookItemKind says what is at a workspace path: "" when nothing is,
// "file" for a Python notebook, otherwise folder, repo, file (a workspace
// file), or notebook (in another language).
func (s *NotebookService) NotebookItemKind(profile, remotePath string) (string, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return "", remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	st, err := c.workspace.GetStatus(ctx, workspace.GetStatusRequest{Path: remotePath})
	if isMissing(err) {
		return "", nil
	}
	if err != nil {
		return "", remoteErr(err)
	}
	switch {
	case st.ObjectType == workspace.ObjectTypeNotebook && st.Language == workspace.LanguagePython:
		return "file", nil
	case st.ObjectType == workspace.ObjectTypeNotebook:
		return strings.ToLower(string(st.Language)) + " notebook", nil
	case st.ObjectType == workspace.ObjectTypeFile:
		return "workspace file", nil
	}
	return objectKind(st.ObjectType), nil
}

func downloadNotebook(ctx context.Context, c *apiClients, remotePath string) (string, *workspace.ObjectInfo, error) {
	st, err := c.workspace.GetStatus(ctx, workspace.GetStatusRequest{Path: remotePath})
	if err != nil {
		if isMissing(err) {
			return "", nil, fmt.Errorf("%s no longer exists in the workspace", remotePath)
		}
		return "", nil, remoteErr(err)
	}
	if st.ObjectType != workspace.ObjectTypeNotebook {
		return "", nil, fmt.Errorf("%s is a %s, not a notebook", remotePath, objectKind(st.ObjectType))
	}
	if st.Language != workspace.LanguagePython {
		return "", nil, fmt.Errorf("%s is a %s notebook; only Python notebooks can be opened", path.Base(remotePath), strings.ToLower(string(st.Language)))
	}
	res, err := c.workspace.Export(ctx, workspace.ExportRequest{Path: remotePath, Format: workspace.ExportFormatSource})
	if err != nil {
		return "", nil, remoteErr(err)
	}
	b, err := base64.StdEncoding.DecodeString(res.Content)
	if err != nil {
		return "", nil, fmt.Errorf("the workspace sent %s in an unexpected form", path.Base(remotePath))
	}
	if len(b) > maxRemoteBytes {
		return "", nil, fmt.Errorf("%s is larger than %d MB", path.Base(remotePath), maxRemoteBytes>>20)
	}
	return string(b), st, nil
}

func uploadNotebook(ctx context.Context, c *apiClients, remotePath, content string) (int64, error) {
	if !strings.HasPrefix(content, strings.TrimSpace(notebookHeader)) {
		content = notebookHeader + content
	}
	err := c.workspace.Import(ctx, workspace.Import{
		Path:      remotePath,
		Content:   base64.StdEncoding.EncodeToString([]byte(content)),
		Format:    workspace.ImportFormatSource,
		Language:  workspace.LanguagePython,
		Overwrite: true,
	})
	if err != nil {
		if isMissing(err) {
			return 0, fmt.Errorf("the folder %s does not exist in the workspace", path.Dir(remotePath))
		}
		return 0, remoteErr(err)
	}
	st, err := c.workspace.GetStatus(ctx, workspace.GetStatusRequest{Path: remotePath})
	if err != nil {
		return 0, remoteErr(err)
	}
	return st.ModifiedAt, nil
}

func (s *NotebookService) storeCopy(profile, remotePath, content string, modifiedAt int64) (NotebookTab, error) {
	m := s.mirror(profile)
	local, err := m.LocalPath(remotePath)
	if err != nil {
		return NotebookTab{}, err
	}
	if err := queries.WriteExt(local, queries.Notebook, content); err != nil {
		return NotebookTab{}, cleanFileErr(err)
	}
	l := wsfiles.Link{RemotePath: remotePath, ModifiedAt: modifiedAt, Hash: wsfiles.Hash(content), Opened: time.Now().UnixMilli()}
	if err := m.Put(l); err != nil {
		return NotebookTab{}, err
	}
	tab, err := s.OpenNotebook(local)
	if err != nil {
		return NotebookTab{}, err
	}
	tab.Remote = &RemoteFile{Path: remotePath, ModifiedAt: modifiedAt}
	return tab, nil
}

// SaveNotebookToWorkspace uploads a local notebook to a workspace path as a
// Python notebook, replacing any notebook there, and returns the tab for its
// new local copy. A scratch notebook is removed once saved, and its session
// moves to the new copy. Callers confirm replacing an existing notebook first.
func (s *NotebookService) SaveNotebookToWorkspace(profile, localPath, folder, name string) (NotebookTab, error) {
	remotePath, err := wsfiles.JoinNotebookName(folder, name)
	if err != nil {
		return NotebookTab{}, err
	}
	content, err := queries.ReadExt(localPath, queries.Notebook)
	if err != nil {
		return NotebookTab{}, cleanFileErr(err)
	}
	c, err := s.pool.get(profile)
	if err != nil {
		return NotebookTab{}, remoteErr(err)
	}
	if kind, err := s.NotebookItemKind(profile, remotePath); err != nil {
		return NotebookTab{}, err
	} else if kind != "" && kind != "file" {
		return NotebookTab{}, fmt.Errorf("%s is a %s in the workspace", path.Base(remotePath), kind)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	modifiedAt, err := uploadNotebook(ctx, c, remotePath, content)
	if err != nil {
		return NotebookTab{}, err
	}
	m := s.mirror(profile)
	_ = m.SetLastFolder(path.Dir(remotePath))
	tab, err := s.storeCopy(profile, remotePath, content, modifiedAt)
	if err != nil {
		return NotebookTab{}, err
	}
	if !samePath(localPath, tab.File.Path) {
		s.sessions.Rename(sessionKey(profile, localPath), sessionKey(profile, tab.File.Path))
		s.kernels.Rename(sessionKey(profile, localPath), sessionKey(profile, tab.File.Path))
		if scratch, err := s.dir(profile); err == nil && wsfiles.Within(scratch, localPath) {
			_ = os.Remove(localPath)
		}
	}
	return tab, nil
}

func samePath(a, b string) bool { return filepath.Clean(a) == filepath.Clean(b) }

// PushNotebook saves a local copy back to its workspace notebook. Unless
// force is set it refuses when the notebook changed or was deleted in the
// workspace since it was downloaded, and reports which.
func (s *NotebookService) PushNotebook(profile, localPath string, force bool) (PushResult, error) {
	m := s.mirror(profile)
	l, ok, err := m.Lookup(localPath)
	if err != nil {
		return PushResult{}, err
	}
	if !ok {
		return PushResult{}, errors.New("this notebook is not linked to a workspace notebook")
	}
	content, err := queries.ReadExt(localPath, queries.Notebook)
	if err != nil {
		return PushResult{}, cleanFileErr(err)
	}
	c, err := s.pool.get(profile)
	if err != nil {
		return PushResult{}, remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	if !force {
		st, err := c.workspace.GetStatus(ctx, workspace.GetStatusRequest{Path: l.RemotePath})
		switch {
		case isMissing(err):
			return PushResult{Status: "missing"}, nil
		case err != nil:
			return PushResult{}, remoteErr(err)
		case st.ObjectType != workspace.ObjectTypeNotebook:
			return PushResult{}, fmt.Errorf("%s is now a %s in the workspace", l.RemotePath, objectKind(st.ObjectType))
		case st.ModifiedAt != l.ModifiedAt:
			return PushResult{Status: "conflict", RemoteModifiedAt: st.ModifiedAt}, nil
		}
	}
	modifiedAt, err := uploadNotebook(ctx, c, l.RemotePath, content)
	if err != nil {
		return PushResult{}, err
	}
	l.ModifiedAt, l.Hash, l.Opened = modifiedAt, wsfiles.Hash(content), time.Now().UnixMilli()
	if err := m.Put(l); err != nil {
		return PushResult{}, err
	}
	return PushResult{Status: "saved", Remote: &RemoteFile{Path: l.RemotePath, ModifiedAt: modifiedAt}}, nil
}

// OpenNotebookFromWorkspace downloads a workspace Python notebook and returns
// its tab. A local copy with edits not yet saved to the workspace is kept as
// it is; otherwise the copy is refreshed from the workspace.
func (s *NotebookService) OpenNotebookFromWorkspace(profile, remotePath string) (NotebookTab, error) {
	remotePath, err := wsfiles.CleanNotebookPath(remotePath)
	if err != nil {
		return NotebookTab{}, err
	}
	m := s.mirror(profile)
	if l, ok, err := m.Get(remotePath); err == nil && ok {
		if local, err := m.LocalPath(remotePath); err == nil {
			if content, err := queries.ReadExt(local, queries.Notebook); err == nil && wsfiles.Hash(content) != l.Hash {
				l.Opened = time.Now().UnixMilli()
				_ = m.Put(l)
				tab, err := s.OpenNotebook(local)
				if err != nil {
					return NotebookTab{}, err
				}
				tab.Remote = &RemoteFile{Path: remotePath, ModifiedAt: l.ModifiedAt, Unsaved: true}
				return tab, nil
			}
		}
	}
	return s.fetch(profile, remotePath)
}

// ReloadNotebookFromWorkspace replaces a local copy with the workspace
// version, discarding local edits.
func (s *NotebookService) ReloadNotebookFromWorkspace(profile, localPath string) (NotebookTab, error) {
	l, ok, err := s.mirror(profile).Lookup(localPath)
	if err != nil {
		return NotebookTab{}, err
	}
	if !ok {
		return NotebookTab{}, errors.New("this notebook is not linked to a workspace notebook")
	}
	return s.fetch(profile, l.RemotePath)
}

func (s *NotebookService) fetch(profile, remotePath string) (NotebookTab, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return NotebookTab{}, remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	content, st, err := downloadNotebook(ctx, c, remotePath)
	if err != nil {
		return NotebookTab{}, err
	}
	return s.storeCopy(profile, remotePath, content, st.ModifiedAt)
}
