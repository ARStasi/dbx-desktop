// Package dbcfg reads and writes the Databricks config file (~/.databrickscfg).
//
// The file is the single source of truth for profiles, shared with the
// Databricks CLI and SDKs. Every write keeps a backup next to it.
package dbcfg

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"gopkg.in/ini.v1"
)

const (
	settingsSection = "__settings__"
	defaultProfile  = "DEFAULT"
	fileMode        = 0o600
)

// ini.v1 formatting options are package globals, so saves are serialized.
var saveMu sync.Mutex

// Profile is one section of the config file, with secrets left out.
type Profile struct {
	Name        string `json:"name"`
	Host        string `json:"host"`
	AuthType    string `json:"authType"`
	AccountID   string `json:"accountId"`
	WorkspaceID string `json:"workspaceId"`
	// HasToken is true when a personal access token is stored in plain text.
	HasToken bool `json:"hasToken"`
	// IsAccount is true for account-console profiles, which are not workspaces.
	IsAccount bool `json:"isAccount"`
	// IsDefault is true for the profile the CLI uses when none is named.
	IsDefault bool `json:"isDefault"`
}

// Path returns the config file location, honoring DATABRICKS_CONFIG_FILE.
func Path() (string, error) {
	if p := os.Getenv("DATABRICKS_CONFIG_FILE"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("find home folder: %w", err)
	}
	return filepath.Join(home, ".databrickscfg"), nil
}

func load(path string) (*ini.File, error) {
	f, err := ini.LoadSources(ini.LoadOptions{Loose: true}, path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return f, nil
}

// List returns every profile in the file. A missing file is an empty list.
func List(path string) ([]Profile, error) {
	f, err := load(path)
	if err != nil {
		return nil, err
	}
	def := defaultProfile
	if s, err := f.GetSection(settingsSection); err == nil {
		if v := s.Key("default_profile").String(); v != "" {
			def = v
		}
	}
	profiles := []Profile{}
	for _, s := range f.Sections() {
		name := s.Name()
		if name == settingsSection || len(s.Keys()) == 0 {
			continue
		}
		host := s.Key("host").String()
		p := Profile{
			Name:        name,
			Host:        host,
			AuthType:    authType(s),
			AccountID:   s.Key("account_id").String(),
			WorkspaceID: s.Key("workspace_id").String(),
			HasToken:    s.Key("token").String() != "",
			IsAccount:   isAccountHost(host),
			IsDefault:   name == def,
		}
		profiles = append(profiles, p)
	}
	sort.SliceStable(profiles, func(i, j int) bool {
		return strings.ToLower(profiles[i].Name) < strings.ToLower(profiles[j].Name)
	})
	return profiles, nil
}

func authType(s *ini.Section) string {
	if v := s.Key("auth_type").String(); v != "" {
		return v
	}
	switch {
	case s.Key("token").String() != "":
		return "pat"
	case s.Key("client_id").String() != "" && s.Key("client_secret").String() != "":
		return "oauth-m2m"
	case s.Key("azure_client_id").String() != "":
		return "azure-client-secret"
	case s.Key("google_service_account").String() != "":
		return "google-id"
	}
	return "unknown"
}

func isAccountHost(host string) bool {
	u, err := url.Parse(host)
	if err != nil {
		return false
	}
	return strings.HasPrefix(u.Hostname(), "accounts.")
}

// NormalizeHost turns whatever the user pasted into https://<hostname>.
// It accepts a bare hostname or a full workspace URL with a path and query.
func NormalizeHost(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("enter the workspace URL")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("that is not a valid URL: %w", err)
	}
	if u.Scheme != "https" {
		return "", errors.New("the workspace URL must start with https://")
	}
	host := u.Hostname()
	if host == "" || !strings.Contains(host, ".") {
		return "", errors.New("that does not look like a workspace URL")
	}
	if u.Port() != "" {
		host += ":" + u.Port()
	}
	return "https://" + strings.ToLower(host), nil
}

// ValidateName checks that a profile name is safe as an INI section name.
func ValidateName(name string) error {
	switch {
	case name == "":
		return errors.New("enter a profile name")
	case name == settingsSection:
		return fmt.Errorf("%q is reserved", settingsSection)
	case strings.ContainsAny(name, "[]\r\n\t;#="):
		return errors.New("the profile name cannot contain brackets, tabs, or any of ; # =")
	case strings.TrimSpace(name) != name:
		return errors.New("the profile name cannot start or end with a space")
	}
	return nil
}

// SuggestName proposes a profile name from a normalized host: its first label.
func SuggestName(host string) string {
	u, err := url.Parse(host)
	if err != nil || u.Hostname() == "" {
		return ""
	}
	return strings.Split(u.Hostname(), ".")[0]
}

// Exists reports whether a profile with that name is in the file.
func Exists(path, name string) (bool, error) {
	f, err := load(path)
	if err != nil {
		return false, err
	}
	s, err := f.GetSection(name)
	if err != nil {
		return false, nil
	}
	return len(s.Keys()) > 0, nil
}

// SaveTokenProfile writes a profile that authenticates with a personal access
// token. The token is stored in plain text, as the CLI and SDKs expect.
func SaveTokenProfile(path, name, host, token string) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("enter a token")
	}
	return edit(path, func(f *ini.File) error {
		s, err := section(f, name)
		if err != nil {
			return err
		}
		s.Key("host").SetValue(host)
		s.Key("token").SetValue(token)
		s.DeleteKey("auth_type")
		return nil
	})
}

// MarkOAuth removes a stored token from a profile and marks it as using the
// CLI's OAuth login. Call it only after a successful browser login.
func MarkOAuth(path, name string) error {
	return edit(path, func(f *ini.File) error {
		s, err := f.GetSection(name)
		if err != nil {
			return fmt.Errorf("profile %q not found", name)
		}
		s.DeleteKey("token")
		s.Key("auth_type").SetValue("databricks-cli")
		return nil
	})
}

// Remove deletes a profile. Removing the default profile also clears the
// default_profile setting that pointed at it.
func Remove(path, name string) error {
	return edit(path, func(f *ini.File) error {
		s, err := f.GetSection(name)
		if err != nil || len(s.Keys()) == 0 {
			return fmt.Errorf("profile %q not found", name)
		}
		if name == defaultProfile {
			// ini.v1 cannot delete its default section, so empty it instead.
			for _, k := range s.KeyStrings() {
				s.DeleteKey(k)
			}
			s.Comment = ""
		} else {
			f.DeleteSection(name)
		}
		if st, err := f.GetSection(settingsSection); err == nil {
			if st.Key("default_profile").String() == name {
				st.DeleteKey("default_profile")
				if len(st.Keys()) == 0 {
					f.DeleteSection(settingsSection)
				}
			}
		}
		return nil
	})
}

// SetDefault records which profile the CLI uses when none is named.
func SetDefault(path, name string) error {
	return edit(path, func(f *ini.File) error {
		if s, err := f.GetSection(name); err != nil || len(s.Keys()) == 0 {
			return fmt.Errorf("profile %q not found", name)
		}
		st, err := section(f, settingsSection)
		if err != nil {
			return err
		}
		st.Key("default_profile").SetValue(name)
		return nil
	})
}

func section(f *ini.File, name string) (*ini.Section, error) {
	if s, err := f.GetSection(name); err == nil {
		return s, nil
	}
	return f.NewSection(name)
}

// edit loads the file, applies fn, backs the original up to <path>.bak, and
// replaces the file atomically.
func edit(path string, fn func(*ini.File) error) error {
	saveMu.Lock()
	defer saveMu.Unlock()

	f, err := load(path)
	if err != nil {
		return err
	}
	if err := fn(f); err != nil {
		return err
	}

	if orig, err := os.ReadFile(path); err == nil {
		if err := os.WriteFile(path+".bak", orig, fileMode); err != nil {
			return fmt.Errorf("back up %s: %w", path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read %s: %w", path, err)
	}

	// Keep the file looking the way the CLI writes it: "key = value", no
	// column alignment, and an explicit [DEFAULT] header when it has keys.
	ini.PrettyFormat = false
	ini.PrettyEqual = true
	ini.DefaultHeader = len(f.Section(defaultProfile).Keys()) > 0

	tmp, err := os.CreateTemp(filepath.Dir(path), ".databrickscfg-*")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := f.WriteTo(tmp); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Chmod(tmpName, fileMode); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
