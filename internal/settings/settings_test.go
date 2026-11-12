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

func TestCorruptFileIsAnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(path, []byte("{not json"), 0o600)
	if _, _, err := New(path).Snapshot(); err == nil {
		t.Fatal("want an error for a corrupt settings file")
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
