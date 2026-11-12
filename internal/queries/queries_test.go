package queries

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSafeName(t *testing.T) {
	cases := map[string]string{
		"DEFAULT":      "DEFAULT",
		"team/prod":    "team_prod",
		`a:b*c?"d"`:    "a_b_c__d_",
		"  spaced.  ":  "spaced",
		"...":          "_",
		"":             "_",
		"my-work.prod": "my-work.prod",
	}
	for in, want := range cases {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNewUntitledWriteReadList(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ws")

	files, err := List(dir)
	if err != nil || len(files) != 0 {
		t.Fatalf("missing dir: %v %v", files, err)
	}

	a, err := NewUntitled(dir)
	if err != nil || a.Name != "Untitled-1.sql" {
		t.Fatalf("first: %+v %v", a, err)
	}
	b, err := NewUntitled(dir)
	if err != nil || b.Name != "Untitled-2.sql" {
		t.Fatalf("second: %+v %v", b, err)
	}

	if err := Write(a.Path, "SELECT 1"); err != nil {
		t.Fatal(err)
	}
	got, err := Read(a.Path)
	if err != nil || got != "SELECT 1" {
		t.Fatalf("read: %q %v", got, err)
	}

	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644)
	files, err = List(dir)
	if err != nil || len(files) != 2 {
		t.Fatalf("list should hold only the two .sql files: %v %v", files, err)
	}
	// No temp files are left behind by Write.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 {
		t.Fatalf("unexpected files in dir: %v", entries)
	}
}

func TestReadWriteRejectNonSQL(t *testing.T) {
	dir := t.TempDir()
	txt := filepath.Join(dir, "secrets.txt")
	os.WriteFile(txt, []byte("x"), 0o644)
	if _, err := Read(txt); err == nil {
		t.Error("Read should refuse a non-.sql file")
	}
	if err := Write(txt, "y"); err == nil {
		t.Error("Write should refuse a non-.sql file")
	}
	if err := Write("relative.sql", "y"); err == nil {
		t.Error("Write should refuse a relative path")
	}
	if b, _ := os.ReadFile(txt); string(b) != "x" {
		t.Error("the non-.sql file must be untouched")
	}
}

func TestRename(t *testing.T) {
	dir := t.TempDir()
	f, _ := NewUntitled(dir)
	Write(f.Path, "SELECT 2")

	r, err := Rename(f.Path, "daily revenue")
	if err != nil || r.Name != "daily revenue.sql" {
		t.Fatalf("rename: %+v %v", r, err)
	}
	if got, _ := Read(r.Path); got != "SELECT 2" {
		t.Errorf("content lost: %q", got)
	}
	if _, err := os.Stat(f.Path); err == nil {
		t.Error("old name should be gone")
	}

	other, _ := NewUntitled(dir)
	if _, err := Rename(other.Path, "daily revenue.sql"); err == nil {
		t.Error("rename must not overwrite an existing file")
	}
	for _, bad := range []string{"", "  ", "a/b", `a\b`, "a:b"} {
		if _, err := Rename(other.Path, bad); err == nil {
			t.Errorf("Rename to %q should fail", bad)
		}
	}
}

func TestHistory(t *testing.T) {
	path := HistoryPath(filepath.Join(t.TempDir(), "history"), "team/prod")
	if filepath.Base(path) != "team_prod.jsonl" {
		t.Fatalf("path = %s", path)
	}
	got, err := ReadHistory(path)
	if err != nil || len(got) != 0 {
		t.Fatalf("empty: %v %v", got, err)
	}
	for i := 1; i <= HistoryKeep+5; i++ {
		e := HistoryEntry{Time: int64(i), Statement: fmt.Sprintf("SELECT %d\nFROM t", i), Status: "SUCCEEDED"}
		if err := AppendHistory(path, e); err != nil {
			t.Fatal(err)
		}
	}
	got, err = ReadHistory(path)
	if err != nil || len(got) != HistoryKeep {
		t.Fatalf("want %d entries, got %d (%v)", HistoryKeep, len(got), err)
	}
	if got[0].Time != int64(HistoryKeep+5) || got[len(got)-1].Time != 6 {
		t.Errorf("order or trim wrong: first %d, last %d", got[0].Time, got[len(got)-1].Time)
	}
	if got[0].Statement != fmt.Sprintf("SELECT %d\nFROM t", HistoryKeep+5) {
		t.Errorf("multi-line statement not preserved: %q", got[0].Statement)
	}
}
