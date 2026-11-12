// Package queries stores SQL scratchpad queries as plain .sql files and keeps
// a per-workspace history of what was run.
package queries

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxFileBytes = 5 << 20
	// HistoryKeep is how many history entries are kept per workspace.
	HistoryKeep = 200
)

// File is a query file on disk.
type File struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Modified int64  `json:"modified"`
}

// DefaultRoot is where query files go unless the user picks another folder.
func DefaultRoot() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home folder: %w", err)
	}
	return filepath.Join(home, "Documents", "dbx-desktop"), nil
}

// Dir returns the folder for one profile's queries under root.
func Dir(root, profile string) string {
	return filepath.Join(root, safeName(profile))
}

// safeName makes a profile name usable as a folder or file name on both
// macOS and Windows.
func safeName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	if name == "" {
		return "_"
	}
	return name
}

// SQL and Notebook are the file extensions the app edits: SQL queries and
// Python notebooks in Databricks source format.
const (
	SQL      = ".sql"
	Notebook = ".py"
)

func checkPath(path, ext string) error {
	if !filepath.IsAbs(path) {
		return errors.New("the file path must be absolute")
	}
	if !strings.EqualFold(filepath.Ext(path), ext) {
		if ext == SQL {
			return errors.New("only .sql files can be opened in the scratchpad")
		}
		return fmt.Errorf("only %s files can be opened here", ext)
	}
	return nil
}

func fileInfo(path string) (File, error) {
	st, err := os.Stat(path)
	if err != nil {
		return File{}, err
	}
	return File{Path: path, Name: filepath.Base(path), Modified: st.ModTime().UnixMilli()}, nil
}

// List returns the .sql files in dir, newest first. A missing folder is an
// empty list.
func List(dir string) ([]File, error) { return ListExt(dir, SQL) }

// ListExt returns the files in dir with extension ext, newest first.
func ListExt(dir, ext string) ([]File, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []File{}, nil
	}
	if err != nil {
		return nil, err
	}
	files := []File{}
	for _, e := range entries {
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ext) {
			continue
		}
		if f, err := fileInfo(filepath.Join(dir, e.Name())); err == nil {
			files = append(files, f)
		}
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].Modified > files[j].Modified })
	return files, nil
}

// Read returns the content of a .sql file.
func Read(path string) (string, error) { return ReadExt(path, SQL) }

// ReadExt returns the content of a file that must have extension ext.
func ReadExt(path, ext string) (string, error) {
	if err := checkPath(path, ext); err != nil {
		return "", err
	}
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.Size() > maxFileBytes {
		return "", fmt.Errorf("%s is larger than %d MB", filepath.Base(path), maxFileBytes>>20)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Write saves content to a .sql file, replacing it atomically.
func Write(path, content string) error { return WriteExt(path, SQL, content) }

// WriteExt saves content to a file that must have extension ext, replacing
// it atomically.
func WriteExt(path, ext, content string) error {
	if err := checkPath(path, ext); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*"+ext)
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// NewUntitled creates an empty Untitled-N.sql in dir, using the first free N.
func NewUntitled(dir string) (File, error) { return NewUntitledExt(dir, SQL, "") }

// NewUntitledExt creates Untitled-N<ext> in dir holding content, using the
// first free N.
func NewUntitledExt(dir, ext, content string) (File, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return File{}, err
	}
	for i := 1; i < 10000; i++ {
		path := filepath.Join(dir, fmt.Sprintf("Untitled-%d%s", i, ext))
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return File{}, err
		}
		_, werr := f.WriteString(content)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			return File{}, werr
		}
		return fileInfo(path)
	}
	return File{}, errors.New("too many untitled files in this folder")
}

// Rename gives a query file a new name in the same folder. It refuses to
// overwrite an existing file.
func Rename(path, newName string) (File, error) { return RenameExt(path, SQL, newName) }

// RenameExt renames a file with extension ext within its folder, adding ext
// to the new name when missing. It refuses to overwrite an existing file.
func RenameExt(path, ext, newName string) (File, error) {
	if err := checkPath(path, ext); err != nil {
		return File{}, err
	}
	newName = strings.TrimSpace(newName)
	if newName == "" {
		return File{}, errors.New("enter a file name")
	}
	if newName != safeName(newName) || strings.ContainsAny(newName, `/\`) {
		return File{}, errors.New(`the file name cannot contain any of < > : " / \ | ? *`)
	}
	if !strings.EqualFold(filepath.Ext(newName), ext) {
		newName += ext
	}
	dst := filepath.Join(filepath.Dir(path), newName)
	if dst == path {
		return fileInfo(path)
	}
	if _, err := os.Lstat(dst); err == nil {
		// A case-only rename on a case-insensitive disk finds the same file.
		if !strings.EqualFold(dst, path) {
			return File{}, fmt.Errorf("a file named %s already exists", newName)
		}
	}
	if err := os.Rename(path, dst); err != nil {
		return File{}, err
	}
	return fileInfo(dst)
}

// HistoryEntry records one statement that was run.
type HistoryEntry struct {
	Time        int64  `json:"time"`
	Statement   string `json:"statement"`
	WarehouseID string `json:"warehouseId"`
	Status      string `json:"status"`
	RowCount    int    `json:"rowCount"`
	DurationMs  int64  `json:"durationMs"`
	Error       string `json:"error,omitempty"`
}

// HistoryPath returns the history file for a profile under dir.
func HistoryPath(dir, profile string) string {
	return filepath.Join(dir, safeName(profile)+".jsonl")
}

// ReadHistory returns entries newest first. A missing file is an empty list
// and unreadable lines are skipped.
func ReadHistory(path string) ([]HistoryEntry, error) {
	entries, err := readHistoryOldestFirst(path)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}
	return entries, nil
}

func readHistoryOldestFirst(path string) ([]HistoryEntry, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return []HistoryEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries := []HistoryEntry{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	for sc.Scan() {
		var e HistoryEntry
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Statement != "" {
			entries = append(entries, e)
		}
	}
	return entries, sc.Err()
}

// AppendHistory adds an entry and trims the file to the newest HistoryKeep.
func AppendHistory(path string, e HistoryEntry) error {
	entries, err := readHistoryOldestFirst(path)
	if err != nil {
		return err
	}
	entries = append(entries, e)
	if len(entries) > HistoryKeep {
		entries = entries[len(entries)-HistoryKeep:]
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	var b strings.Builder
	enc := json.NewEncoder(&b)
	for _, e := range entries {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
