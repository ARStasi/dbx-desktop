// Package wsfiles keeps local copies of SQL files saved in a Databricks
// workspace. Each copy is a plain .sql file the scratchpad edits and saves
// locally as usual; an index records which workspace file it came from and
// what that file looked like when it was last downloaded or uploaded, so the
// app can tell local edits apart from changes made in Databricks.
package wsfiles

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// RecentKeep is how many workspace files the index remembers.
const RecentKeep = 50

// Link ties a local copy to its workspace file.
type Link struct {
	RemotePath string `json:"remotePath"`
	// ModifiedAt is the workspace file's modified time, in Unix milliseconds,
	// when the copy was last downloaded or uploaded.
	ModifiedAt int64 `json:"modifiedAt"`
	// Hash is the SHA-256 of the content at that time. A local copy whose
	// hash differs has edits that are not in the workspace.
	Hash string `json:"hash"`
	// Opened is when the file was last opened or saved, in Unix milliseconds.
	Opened int64 `json:"opened"`
}

type index struct {
	// LastFolder is the workspace folder the last file was saved to.
	LastFolder string          `json:"lastFolder,omitempty"`
	Files      map[string]Link `json:"files"`
}

// Mirror holds one workspace's local copies under a root folder.
type Mirror struct {
	root string
	mu   sync.Mutex
}

// New returns the mirror rooted at root. Nothing is created until a file is
// written.
func New(root string) *Mirror { return &Mirror{root: root} }

// Hash returns the hash stored in a Link for content.
func Hash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// CleanRemotePath checks a workspace path for a SQL file and normalizes it.
func CleanRemotePath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if !strings.HasPrefix(p, "/") {
		return "", errors.New("the workspace path must start with /")
	}
	p = path.Clean(p)
	if p == "/" || strings.Contains(p, "\\") {
		return "", fmt.Errorf("%s is not a valid workspace file path", p)
	}
	if !strings.EqualFold(path.Ext(p), ".sql") {
		return "", errors.New("only .sql files can be opened in the scratchpad")
	}
	return p, nil
}

// CleanFolder checks a workspace folder path and normalizes it.
func CleanFolder(p string) (string, error) {
	p = strings.TrimSpace(p)
	if !strings.HasPrefix(p, "/") {
		return "", errors.New("the workspace folder must start with /")
	}
	return path.Clean(p), nil
}

// JoinName adds a file name to a workspace folder, adding .sql when missing.
func JoinName(folder, name string) (string, error) {
	folder, err := CleanFolder(folder)
	if err != nil {
		return "", err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("enter a file name")
	}
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", errors.New(`the file name cannot contain / or \`)
	}
	if !strings.EqualFold(path.Ext(name), ".sql") {
		name += ".sql"
	}
	return CleanRemotePath(path.Join(folder, name))
}

// LocalPath is where the local copy of a workspace file lives.
func (m *Mirror) LocalPath(remotePath string) (string, error) {
	p, err := CleanRemotePath(remotePath)
	if err != nil {
		return "", err
	}
	parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
	for i, s := range parts {
		parts[i] = safeSegment(s)
	}
	return filepath.Join(append([]string{m.root, "files"}, parts...)...), nil
}

// safeSegment makes one workspace path segment usable as a file or folder
// name on both macOS and Windows.
func safeSegment(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, s)
	// Windows drops trailing dots and spaces from names.
	if t := strings.TrimRight(s, " ."); t != s {
		s = t + "_"
	}
	if s == "" {
		return "_"
	}
	return s
}

func (m *Mirror) indexPath() string { return filepath.Join(m.root, "index.json") }

func (m *Mirror) read() (index, error) {
	ix := index{Files: map[string]Link{}}
	b, err := os.ReadFile(m.indexPath())
	if errors.Is(err, os.ErrNotExist) {
		return ix, nil
	}
	if err != nil {
		return ix, err
	}
	if err := json.Unmarshal(b, &ix); err != nil {
		// A damaged index only loses the links; the copies stay on disk.
		return index{Files: map[string]Link{}}, nil
	}
	if ix.Files == nil {
		ix.Files = map[string]Link{}
	}
	return ix, nil
}

func (m *Mirror) write(ix index) error {
	// Forget the oldest links beyond RecentKeep. Their copies stay on disk.
	if len(ix.Files) > RecentKeep {
		links := make([]Link, 0, len(ix.Files))
		for _, l := range ix.Files {
			links = append(links, l)
		}
		sort.Slice(links, func(i, j int) bool { return links[i].Opened > links[j].Opened })
		for _, l := range links[RecentKeep:] {
			delete(ix.Files, l.RemotePath)
		}
	}
	if err := os.MkdirAll(m.root, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(ix, "", "  ")
	if err != nil {
		return err
	}
	tmp := m.indexPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.indexPath())
}

// Get returns the link for a workspace path.
func (m *Mirror) Get(remotePath string) (Link, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ix, err := m.read()
	if err != nil {
		return Link{}, false, err
	}
	l, ok := ix.Files[remotePath]
	return l, ok, nil
}

// Lookup finds the link whose local copy is at localPath.
func (m *Mirror) Lookup(localPath string) (Link, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ix, err := m.read()
	if err != nil {
		return Link{}, false, err
	}
	for _, l := range ix.Files {
		if p, err := m.LocalPath(l.RemotePath); err == nil && samePath(p, localPath) {
			return l, true, nil
		}
	}
	return Link{}, false, nil
}

func samePath(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b)
}

// Put saves a link.
func (m *Mirror) Put(l Link) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ix, err := m.read()
	if err != nil {
		return err
	}
	ix.Files[l.RemotePath] = l
	return m.write(ix)
}

// Recent returns the links, most recently opened first.
func (m *Mirror) Recent() ([]Link, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ix, err := m.read()
	if err != nil {
		return nil, err
	}
	out := make([]Link, 0, len(ix.Files))
	for _, l := range ix.Files {
		out = append(out, l)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Opened > out[j].Opened })
	return out, nil
}

// LastFolder returns the workspace folder the last file was saved to.
func (m *Mirror) LastFolder() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ix, err := m.read()
	return ix.LastFolder, err
}

// SetLastFolder remembers the folder a file was saved to.
func (m *Mirror) SetLastFolder(folder string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ix, err := m.read()
	if err != nil {
		return err
	}
	ix.LastFolder = folder
	return m.write(ix)
}

// Within reports whether path is inside dir.
func Within(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	if err != nil || rel == "." || filepath.IsAbs(rel) {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
