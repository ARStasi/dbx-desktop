// Package settings stores app-only metadata that does not belong in
// ~/.databrickscfg: per-workspace color, nickname, production flag and default
// volume, plus the last active workspace. It never holds credentials.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// WorkspaceMeta is the app's own metadata for one profile.
type WorkspaceMeta struct {
	Nickname      string `json:"nickname"`
	Color         string `json:"color"`
	Prod          bool   `json:"prod"`
	DefaultVolume string `json:"defaultVolume"`
}

// SQLState is what the SQL scratchpad remembers for one profile.
type SQLState struct {
	WarehouseID string   `json:"warehouseId"`
	Tabs        []string `json:"tabs"`
	ActiveTab   string   `json:"activeTab"`
}

// CatalogPrefs is how the catalog browser is set up for one profile.
type CatalogPrefs struct {
	// Visible lists the catalogs to show. Empty means all of them.
	Visible []string `json:"visible,omitempty"`
	// Current is the catalog that was open last.
	Current string `json:"current,omitempty"`
}

type data struct {
	Active     string                   `json:"active"`
	Workspaces map[string]WorkspaceMeta `json:"workspaces"`
	// QueriesDir is the folder new query files are created in. Empty means
	// the default, Documents/dbx-desktop.
	QueriesDir string                  `json:"queriesDir,omitempty"`
	SQL        map[string]SQLState     `json:"sql,omitempty"`
	Catalogs   map[string]CatalogPrefs `json:"catalogs,omitempty"`
}

// Store is a JSON file in the per-user config folder.
type Store struct {
	path string
	mu   sync.Mutex
}

// DefaultPath returns <user config dir>/dbx-desktop/settings.json, or the
// folder named by DBX_DESKTOP_CONFIG_DIR when set.
func DefaultPath() (string, error) {
	dir := os.Getenv("DBX_DESKTOP_CONFIG_DIR")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("find config folder: %w", err)
		}
		dir = filepath.Join(base, "dbx-desktop")
	}
	return filepath.Join(dir, "settings.json"), nil
}

// New returns a store backed by the file at path.
func New(path string) *Store { return &Store{path: path} }

func (s *Store) read() (data, error) {
	d := data{Workspaces: map[string]WorkspaceMeta{}, SQL: map[string]SQLState{}, Catalogs: map[string]CatalogPrefs{}}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return d, nil
	}
	if err != nil {
		return d, fmt.Errorf("read settings: %w", err)
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return d, fmt.Errorf("settings file %s is not valid JSON: %w", s.path, err)
	}
	if d.Workspaces == nil {
		d.Workspaces = map[string]WorkspaceMeta{}
	}
	if d.SQL == nil {
		d.SQL = map[string]SQLState{}
	}
	if d.Catalogs == nil {
		d.Catalogs = map[string]CatalogPrefs{}
	}
	return d, nil
}

func (s *Store) write(d data) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("write settings: %w", err)
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("write settings: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("write settings: %w", err)
	}
	return nil
}

// Snapshot returns the active profile name and all workspace metadata.
func (s *Store) Snapshot() (string, map[string]WorkspaceMeta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.read()
	return d.Active, d.Workspaces, err
}

// SetMeta saves the metadata for one profile.
func (s *Store) SetMeta(profile string, m WorkspaceMeta) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.read()
	if err != nil {
		return err
	}
	d.Workspaces[profile] = m
	return s.write(d)
}

// SetActive records the last active profile.
func (s *Store) SetActive(profile string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.read()
	if err != nil {
		return err
	}
	d.Active = profile
	return s.write(d)
}

// Forget drops the metadata for a removed profile.
func (s *Store) Forget(profile string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.read()
	if err != nil {
		return err
	}
	delete(d.Workspaces, profile)
	delete(d.SQL, profile)
	delete(d.Catalogs, profile)
	if d.Active == profile {
		d.Active = ""
	}
	return s.write(d)
}

// SQL returns the scratchpad state for a profile and the queries folder
// override, which is empty when the default applies.
func (s *Store) SQL(profile string) (SQLState, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.read()
	return d.SQL[profile], d.QueriesDir, err
}

// SetSQL saves the scratchpad state for a profile.
func (s *Store) SetSQL(profile string, st SQLState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.read()
	if err != nil {
		return err
	}
	d.SQL[profile] = st
	return s.write(d)
}

// Catalogs returns the catalog browser preferences for a profile.
func (s *Store) Catalogs(profile string) (CatalogPrefs, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.read()
	return d.Catalogs[profile], err
}

// SetCatalogs saves the catalog browser preferences for a profile.
func (s *Store) SetCatalogs(profile string, p CatalogPrefs) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.read()
	if err != nil {
		return err
	}
	if len(p.Visible) == 0 && p.Current == "" {
		delete(d.Catalogs, profile)
	} else {
		d.Catalogs[profile] = p
	}
	return s.write(d)
}
