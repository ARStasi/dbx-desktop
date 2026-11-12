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
	"time"

	"github.com/databricks/databricks-sdk-go/apierr"
	"github.com/databricks/databricks-sdk-go/service/iam"
	"github.com/databricks/databricks-sdk-go/service/workspace"

	"dbx-desktop/internal/queries"
	"dbx-desktop/internal/wsfiles"
)

// The workspace accepts larger files, but the scratchpad edits SQL text.
const maxRemoteBytes = 5 << 20

// RemoteFile describes the workspace file behind a query tab.
type RemoteFile struct {
	Path string `json:"path"`
	// ModifiedAt is when the workspace file last changed, as far as the app
	// knows, in Unix milliseconds.
	ModifiedAt int64 `json:"modifiedAt"`
	// Unsaved is true when the local copy has edits not saved to the workspace.
	Unsaved bool `json:"unsaved"`
}

// WorkspaceItem is an entry in a workspace folder.
type WorkspaceItem struct {
	Path string `json:"path"`
	Name string `json:"name"`
	// Kind is folder, repo (a Git folder) or file. Only .sql files are listed.
	Kind     string `json:"kind"`
	Modified int64  `json:"modified"`
}

// RecentWorkspaceFile is a workspace file opened or saved from this computer.
type RecentWorkspaceFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Opened  int64  `json:"opened"`
	Unsaved bool   `json:"unsaved"`
}

// WorkspacePlaces is where the workspace browser starts.
type WorkspacePlaces struct {
	// Home is the user's home folder, /Users/<user name>.
	Home string `json:"home"`
	// LastFolder is the folder a file was last saved to, or Home.
	LastFolder string                `json:"lastFolder"`
	Recent     []RecentWorkspaceFile `json:"recent"`
}

// PushResult is the outcome of saving a local copy to the workspace.
type PushResult struct {
	// Status is saved, conflict (the workspace file changed since it was
	// downloaded) or missing (the workspace file was deleted).
	Status string      `json:"status"`
	Remote *RemoteFile `json:"remote"`
	// RemoteModifiedAt is the workspace file's modified time on a conflict.
	RemoteModifiedAt int64 `json:"remoteModifiedAt"`
}

func (s *SQLService) mirror(profile string) *wsfiles.Mirror {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.mirrors[profile]
	if !ok {
		m = wsfiles.New(queries.Dir(s.mirrorDir, profile))
		s.mirrors[profile] = m
	}
	return m
}

// remoteInfo returns the workspace link of a local file, or nil.
func (s *SQLService) remoteInfo(profile, localPath, content string) *RemoteFile {
	l, ok, err := s.mirror(profile).Lookup(localPath)
	if err != nil || !ok {
		return nil
	}
	return &RemoteFile{Path: l.RemotePath, ModifiedAt: l.ModifiedAt, Unsaved: wsfiles.Hash(content) != l.Hash}
}

func isMissing(err error) bool {
	return errors.Is(err, apierr.ErrResourceDoesNotExist) || errors.Is(err, apierr.ErrNotFound)
}

func remoteErr(err error) error {
	return errors.New(cleanErr(err))
}

func withTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), browseTimeout)
}

// WorkspacePlaces returns the user's home folder, the last folder saved to
// and the workspace files recently used from this computer.
func (s *SQLService) WorkspacePlaces(profile string) (WorkspacePlaces, error) {
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
			if content, err := queries.Read(local); err == nil {
				r.Unsaved = wsfiles.Hash(content) != l.Hash
			}
		}
		out.Recent = append(out.Recent, r)
	}
	return out, nil
}

// ListWorkspace lists the folders, Git folders and .sql files in a workspace
// folder: folders first, then files, each sorted by name.
func (s *SQLService) ListWorkspace(profile, folder string) ([]WorkspaceItem, error) {
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
			continue // hidden folders such as .assistant hold app data, not queries
		}
		switch o.ObjectType {
		case workspace.ObjectTypeDirectory:
			item.Kind = "folder"
		case workspace.ObjectTypeRepo:
			item.Kind = "repo"
		case workspace.ObjectTypeFile:
			if !strings.EqualFold(path.Ext(o.Path), ".sql") {
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

// WorkspaceItemKind says what is at a workspace path: "" when nothing is,
// otherwise file, folder, repo, notebook or another object type in lower case.
func (s *SQLService) WorkspaceItemKind(profile, remotePath string) (string, error) {
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
	return objectKind(st.ObjectType), nil
}

func objectKind(t workspace.ObjectType) string {
	switch t {
	case workspace.ObjectTypeDirectory:
		return "folder"
	case workspace.ObjectTypeRepo:
		return "repo"
	default:
		return strings.ToLower(string(t))
	}
}

// download reads a workspace .sql file and its status.
func download(ctx context.Context, c *apiClients, remotePath string) (string, *workspace.ObjectInfo, error) {
	st, err := c.workspace.GetStatus(ctx, workspace.GetStatusRequest{Path: remotePath})
	if err != nil {
		if isMissing(err) {
			return "", nil, fmt.Errorf("%s no longer exists in the workspace", remotePath)
		}
		return "", nil, remoteErr(err)
	}
	if st.ObjectType != workspace.ObjectTypeFile {
		return "", nil, fmt.Errorf("%s is a %s, not a file", remotePath, objectKind(st.ObjectType))
	}
	if st.Size > maxRemoteBytes {
		return "", nil, fmt.Errorf("%s is larger than %d MB", path.Base(remotePath), maxRemoteBytes>>20)
	}
	res, err := c.workspace.Export(ctx, workspace.ExportRequest{Path: remotePath, Format: workspace.ExportFormatSource})
	if err != nil {
		return "", nil, remoteErr(err)
	}
	b, err := base64.StdEncoding.DecodeString(res.Content)
	if err != nil {
		return "", nil, fmt.Errorf("the workspace sent %s in an unexpected form", path.Base(remotePath))
	}
	return string(b), st, nil
}

// upload writes content to a workspace file, replacing it, and returns the
// file's new modified time.
func upload(ctx context.Context, c *apiClients, remotePath, content string) (int64, error) {
	err := c.workspace.Import(ctx, workspace.Import{
		Path:      remotePath,
		Content:   base64.StdEncoding.EncodeToString([]byte(content)),
		Format:    workspace.ImportFormatRaw,
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

// storeCopy writes the local copy of a workspace file and records its link.
func (s *SQLService) storeCopy(profile, remotePath, content string, modifiedAt int64) (QueryTab, error) {
	m := s.mirror(profile)
	local, err := m.LocalPath(remotePath)
	if err != nil {
		return QueryTab{}, err
	}
	if err := queries.Write(local, content); err != nil {
		return QueryTab{}, cleanFileErr(err)
	}
	l := wsfiles.Link{RemotePath: remotePath, ModifiedAt: modifiedAt, Hash: wsfiles.Hash(content), Opened: time.Now().UnixMilli()}
	if err := m.Put(l); err != nil {
		return QueryTab{}, err
	}
	tab, err := s.OpenQueryFile(local)
	if err != nil {
		return QueryTab{}, err
	}
	tab.Remote = &RemoteFile{Path: remotePath, ModifiedAt: modifiedAt}
	return tab, nil
}

// SaveToWorkspace uploads a local query file to a workspace path, replacing
// any file there, and returns the tab for its new local copy. When the file
// came from the scratchpad folder it is removed, since the workspace now
// holds it. Callers confirm replacing an existing file first.
func (s *SQLService) SaveToWorkspace(profile, localPath, folder, name string) (QueryTab, error) {
	remotePath, err := wsfiles.JoinName(folder, name)
	if err != nil {
		return QueryTab{}, err
	}
	content, err := queries.Read(localPath)
	if err != nil {
		return QueryTab{}, cleanFileErr(err)
	}
	c, err := s.pool.get(profile)
	if err != nil {
		return QueryTab{}, remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	if kind, err := s.WorkspaceItemKind(profile, remotePath); err != nil {
		return QueryTab{}, err
	} else if kind != "" && kind != "file" {
		return QueryTab{}, fmt.Errorf("%s is a %s in the workspace", path.Base(remotePath), kind)
	}
	modifiedAt, err := upload(ctx, c, remotePath, content)
	if err != nil {
		return QueryTab{}, err
	}
	m := s.mirror(profile)
	_ = m.SetLastFolder(path.Dir(remotePath))
	tab, err := s.storeCopy(profile, remotePath, content, modifiedAt)
	if err != nil {
		return QueryTab{}, err
	}
	if scratch, err := s.dir(profile); err == nil && wsfiles.Within(scratch, localPath) && filepath.Clean(localPath) != filepath.Clean(tab.File.Path) {
		_ = os.Remove(localPath)
	}
	return tab, nil
}

// PushToWorkspace saves a local copy back to its workspace file. Unless force
// is set it refuses when the workspace file changed or was deleted since it
// was downloaded, and reports which.
func (s *SQLService) PushToWorkspace(profile, localPath string, force bool) (PushResult, error) {
	m := s.mirror(profile)
	l, ok, err := m.Lookup(localPath)
	if err != nil {
		return PushResult{}, err
	}
	if !ok {
		return PushResult{}, errors.New("this query is not linked to a workspace file")
	}
	content, err := queries.Read(localPath)
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
		case st.ObjectType != workspace.ObjectTypeFile:
			return PushResult{}, fmt.Errorf("%s is now a %s in the workspace", l.RemotePath, objectKind(st.ObjectType))
		case st.ModifiedAt != l.ModifiedAt:
			return PushResult{Status: "conflict", RemoteModifiedAt: st.ModifiedAt}, nil
		}
	}
	modifiedAt, err := upload(ctx, c, l.RemotePath, content)
	if err != nil {
		return PushResult{}, err
	}
	l.ModifiedAt, l.Hash, l.Opened = modifiedAt, wsfiles.Hash(content), time.Now().UnixMilli()
	if err := m.Put(l); err != nil {
		return PushResult{}, err
	}
	return PushResult{Status: "saved", Remote: &RemoteFile{Path: l.RemotePath, ModifiedAt: modifiedAt}}, nil
}

// OpenFromWorkspace downloads a workspace .sql file and returns its tab. A
// local copy with edits not yet saved to the workspace is kept as it is;
// otherwise the copy is refreshed from the workspace.
func (s *SQLService) OpenFromWorkspace(profile, remotePath string) (QueryTab, error) {
	remotePath, err := wsfiles.CleanRemotePath(remotePath)
	if err != nil {
		return QueryTab{}, err
	}
	m := s.mirror(profile)
	if l, ok, err := m.Get(remotePath); err == nil && ok {
		if local, err := m.LocalPath(remotePath); err == nil {
			if content, err := queries.Read(local); err == nil && wsfiles.Hash(content) != l.Hash {
				l.Opened = time.Now().UnixMilli()
				_ = m.Put(l)
				tab, err := s.OpenQueryFile(local)
				if err != nil {
					return QueryTab{}, err
				}
				tab.Remote = &RemoteFile{Path: remotePath, ModifiedAt: l.ModifiedAt, Unsaved: true}
				return tab, nil
			}
		}
	}
	return s.fetch(profile, remotePath)
}

// ReloadFromWorkspace replaces a local copy with the workspace version,
// discarding local edits.
func (s *SQLService) ReloadFromWorkspace(profile, localPath string) (QueryTab, error) {
	l, ok, err := s.mirror(profile).Lookup(localPath)
	if err != nil {
		return QueryTab{}, err
	}
	if !ok {
		return QueryTab{}, errors.New("this query is not linked to a workspace file")
	}
	return s.fetch(profile, l.RemotePath)
}

func (s *SQLService) fetch(profile, remotePath string) (QueryTab, error) {
	c, err := s.pool.get(profile)
	if err != nil {
		return QueryTab{}, remoteErr(err)
	}
	ctx, cancel := withTimeout()
	defer cancel()
	content, st, err := download(ctx, c, remotePath)
	if err != nil {
		return QueryTab{}, err
	}
	return s.storeCopy(profile, remotePath, content, st.ModifiedAt)
}
