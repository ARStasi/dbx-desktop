package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "nested", "settings.json"))

	active, ws, err := s.Snapshot()
	if err != nil || active != "" || len(ws) != 0 {
		t.Fatalf("empty store: %q %v %v", active, ws, err)
	}

	m := WorkspaceMeta{Nickname: "Prod", Color: "#FF3621", Prod: true, DefaultVolume: "main.raw.landing"}
	if err := s.SetMeta("prod", m); err != nil {
		t.Fatal(err)
	}
	if err := s.SetActive("prod"); err != nil {
		t.Fatal(err)
	}
	active, ws, err = s.Snapshot()
	if err != nil || active != "prod" || ws["prod"] != m {
		t.Fatalf("after save: %q %v %v", active, ws, err)
	}

	if err := s.Forget("prod"); err != nil {
		t.Fatal(err)
	}
	active, ws, _ = s.Snapshot()
	if active != "" || len(ws) != 0 {
		t.Fatalf("after forget: %q %v", active, ws)
	}
}

func TestDesktopPreferencesPersistAcrossWorkspaceChanges(t *testing.T) {
	p := filepath.Join(t.TempDir(), "settings.json")
	s := New(p)
	defaults, err := s.Desktop()
	if err != nil || !defaults.KeepInTray || defaults.Notifications {
		t.Fatalf("defaults: %+v %v", defaults, err)
	}
	want := DesktopPrefs{KeepInTray: false, Notifications: true}
	if err := s.SetDesktop(want); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta("dev", WorkspaceMeta{Nickname: "Dev"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Forget("dev"); err != nil {
		t.Fatal(err)
	}
	got, err := New(p).Desktop()
	if err != nil || got != want {
		t.Fatalf("preferences lost: %+v %v", got, err)
	}
	// An explicit false must stay false, including after reopening the store.
	if err := s.SetDesktop(DesktopPrefs{}); err != nil {
		t.Fatal(err)
	}
	got, err = New(p).Desktop()
	if err != nil || got != (DesktopPrefs{}) {
		t.Fatalf("false preferences lost: %+v %v", got, err)
	}
}

func TestCorruptFileIsAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte("{not json"), 0o600)
	if _, _, err := New(path).Snapshot(); err == nil {
		t.Fatal("want an error for a corrupt settings file")
	}
}

func TestCloudWatchSurvivesWorkspaceChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s := New(path)
	if err := s.SetCloudWatch(map[string][]string{"aws": {"east", "west"}, "azure": {"central"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMeta("dev", WorkspaceMeta{Nickname: "Dev"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSQL("dev", SQLState{WarehouseID: "wh"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Forget("dev"); err != nil {
		t.Fatal(err)
	}
	watch, err := New(path).CloudWatch()
	if err != nil || len(watch["aws"]) != 2 || len(watch["azure"]) != 1 {
		t.Fatalf("watch preferences lost: %v %v", watch, err)
	}
}

func TestSQLState(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "settings.json"))
	st, dir, err := s.SQL("dev")
	if err != nil || dir != "" || st.WarehouseID != "" || len(st.Tabs) != 0 {
		t.Fatalf("empty: %+v %q %v", st, dir, err)
	}
	want := SQLState{WarehouseID: "abc", Tabs: []string{"/a.sql", "/b.sql"}, ActiveTab: "/b.sql"}
	if err := s.SetSQL("dev", want); err != nil {
		t.Fatal(err)
	}
	got, _, _ := s.SQL("dev")
	if got.WarehouseID != "abc" || len(got.Tabs) != 2 || got.ActiveTab != "/b.sql" {
		t.Fatalf("got %+v", got)
	}
	// Workspace metadata and SQL state do not overwrite each other.
	if err := s.SetMeta("dev", WorkspaceMeta{Nickname: "Dev"}); err != nil {
		t.Fatal(err)
	}
	got, _, _ = s.SQL("dev")
	if got.WarehouseID != "abc" {
		t.Fatal("SetMeta lost the SQL state")
	}
	if err := s.Forget("dev"); err != nil {
		t.Fatal(err)
	}
	got, _, _ = s.SQL("dev")
	if got.WarehouseID != "" {
		t.Fatal("Forget should drop the SQL state")
	}
}

func TestCatalogPrefs(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "settings.json"))
	if p, err := s.Catalogs("dev"); err != nil || len(p.Visible) != 0 || p.Current != "" {
		t.Fatalf("empty: %+v %v", p, err)
	}
	want := CatalogPrefs{Visible: []string{"main", "sandbox"}, Current: "sandbox"}
	if err := s.SetCatalogs("dev", want); err != nil {
		t.Fatal(err)
	}
	// Saving scratchpad state leaves catalog preferences alone.
	if err := s.SetSQL("dev", SQLState{WarehouseID: "abc"}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Catalogs("dev")
	if len(got.Visible) != 2 || got.Visible[1] != "sandbox" || got.Current != "sandbox" {
		t.Fatalf("got %+v", got)
	}
	if err := s.Forget("dev"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Catalogs("dev"); len(got.Visible) != 0 || got.Current != "" {
		t.Fatalf("after forget: %+v", got)
	}
}
