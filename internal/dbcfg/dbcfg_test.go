package dbcfg

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sample = `; The profile defined in the DEFAULT section is used as a fallback.
[DEFAULT]
host      = https://dbc-aaa.cloud.databricks.com
auth_type = databricks-cli

# work prod
[prod]
host  = https://prod.cloud.databricks.com
token = dapi123
custom_key = keep-me

[acct]
host       = https://accounts.cloud.databricks.com
account_id = abc
auth_type  = databricks-cli

[__settings__]
default_profile = prod
`

func writeSample(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".databrickscfg")
	if err := os.WriteFile(path, []byte(sample), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func byName(t *testing.T, path string) map[string]Profile {
	t.Helper()
	ps, err := List(path)
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]Profile{}
	for _, p := range ps {
		m[p.Name] = p
	}
	return m
}

func TestListMissingFile(t *testing.T) {
	ps, err := List(filepath.Join(t.TempDir(), "nope"))
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != 0 {
		t.Fatalf("want no profiles, got %v", ps)
	}
}

func TestList(t *testing.T) {
	m := byName(t, writeSample(t))
	if len(m) != 3 {
		t.Fatalf("want 3 profiles, got %d: %v", len(m), m)
	}
	if _, ok := m["__settings__"]; ok {
		t.Fatal("__settings__ must not be listed as a profile")
	}
	d := m["DEFAULT"]
	if d.AuthType != "databricks-cli" || d.HasToken || d.IsDefault || d.IsAccount {
		t.Errorf("DEFAULT: %+v", d)
	}
	p := m["prod"]
	if p.AuthType != "pat" || !p.HasToken || !p.IsDefault {
		t.Errorf("prod: %+v", p)
	}
	if a := m["acct"]; !a.IsAccount || a.AccountID != "abc" {
		t.Errorf("acct: %+v", a)
	}
}

func TestDefaultFallsBackToDEFAULT(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg")
	os.WriteFile(path, []byte("[DEFAULT]\nhost = https://a.b.com\n"), 0o600)
	if !byName(t, path)["DEFAULT"].IsDefault {
		t.Fatal("DEFAULT should be the default profile when no setting names one")
	}
}

func TestSaveTokenProfilePreservesRest(t *testing.T) {
	path := writeSample(t)
	if err := SaveTokenProfile(path, "dev", "https://dev.cloud.databricks.com", " dapi999 "); err != nil {
		t.Fatal(err)
	}
	got := read(t, path)
	for _, want := range []string{
		"[DEFAULT]", "[prod]", "custom_key = keep-me", "# work prod",
		"[dev]", "host = https://dev.cloud.databricks.com", "token = dapi999",
		"default_profile = prod",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("file is missing %q:\n%s", want, got)
		}
	}
	if read(t, path+".bak") != sample {
		t.Error("backup should hold the original file")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
	if n := len(byName(t, path)); n != 4 {
		t.Errorf("want 4 profiles after add, got %d", n)
	}
}

func TestSaveTokenProfileCreatesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg")
	if err := SaveTokenProfile(path, "DEFAULT", "https://a.b.com", "tok"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(read(t, path), "[DEFAULT]") {
		t.Errorf("DEFAULT header missing:\n%s", read(t, path))
	}
	if p := byName(t, path)["DEFAULT"]; !p.HasToken || p.Host != "https://a.b.com" {
		t.Errorf("%+v", p)
	}
}

func TestMarkOAuth(t *testing.T) {
	path := writeSample(t)
	if err := MarkOAuth(path, "prod"); err != nil {
		t.Fatal(err)
	}
	p := byName(t, path)["prod"]
	if p.HasToken || p.AuthType != "databricks-cli" {
		t.Errorf("%+v", p)
	}
	if strings.Contains(read(t, path), "dapi123") {
		t.Error("token should be gone from the file")
	}
	if !strings.Contains(read(t, path), "custom_key = keep-me") {
		t.Error("unrelated keys should be kept")
	}
}

func TestRemove(t *testing.T) {
	path := writeSample(t)
	if err := Remove(path, "prod"); err != nil {
		t.Fatal(err)
	}
	m := byName(t, path)
	if _, ok := m["prod"]; ok || len(m) != 2 {
		t.Fatalf("prod should be gone: %v", m)
	}
	if strings.Contains(read(t, path), "default_profile") {
		t.Error("default_profile pointing at the removed profile should be cleared")
	}
	if !m["DEFAULT"].IsDefault {
		t.Error("DEFAULT should become the default again")
	}
	if err := Remove(path, "prod"); err == nil {
		t.Error("removing a missing profile should fail")
	}
}

func TestRemoveDEFAULT(t *testing.T) {
	path := writeSample(t)
	if err := Remove(path, "DEFAULT"); err != nil {
		t.Fatal(err)
	}
	m := byName(t, path)
	if _, ok := m["DEFAULT"]; ok || len(m) != 2 {
		t.Fatalf("DEFAULT should be gone: %v", m)
	}
}

func TestSetDefault(t *testing.T) {
	path := writeSample(t)
	if err := SetDefault(path, "DEFAULT"); err != nil {
		t.Fatal(err)
	}
	m := byName(t, path)
	if !m["DEFAULT"].IsDefault || m["prod"].IsDefault {
		t.Errorf("%v", m)
	}
	if err := SetDefault(path, "missing"); err == nil {
		t.Error("want error for a missing profile")
	}
}

func TestNormalizeHost(t *testing.T) {
	ok := map[string]string{
		"dbc-1.cloud.databricks.com":                       "https://dbc-1.cloud.databricks.com",
		" https://DBC-1.cloud.databricks.com/ ":            "https://dbc-1.cloud.databricks.com",
		"https://adb-1.2.azuredatabricks.net/?o=123#job/5": "https://adb-1.2.azuredatabricks.net",
		"https://x.cloud.databricks.com/sql/editor?o=1":    "https://x.cloud.databricks.com",
		"https://x.cloud.databricks.com:8443/path":         "https://x.cloud.databricks.com:8443",
	}
	for in, want := range ok {
		got, err := NormalizeHost(in)
		if err != nil || got != want {
			t.Errorf("NormalizeHost(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", "http://x.cloud.databricks.com", "localhost", "ftp://a.b.com"} {
		if got, err := NormalizeHost(in); err == nil {
			t.Errorf("NormalizeHost(%q) = %q, want error", in, got)
		}
	}
}

func TestValidateName(t *testing.T) {
	for _, n := range []string{"dev", "DEFAULT", "my-work.prod", "Team A"} {
		if err := ValidateName(n); err != nil {
			t.Errorf("ValidateName(%q): %v", n, err)
		}
	}
	for _, n := range []string{"", "__settings__", "a[b]", "a\nb", " lead", "a=b", "a#b"} {
		if err := ValidateName(n); err == nil {
			t.Errorf("ValidateName(%q) should fail", n)
		}
	}
}

func TestSuggestName(t *testing.T) {
	if got := SuggestName("https://dbc-5d80.cloud.databricks.com"); got != "dbc-5d80" {
		t.Errorf("got %q", got)
	}
}
