package wsfiles

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestCleanRemotePath(t *testing.T) {
	for in, want := range map[string]string{
		"/Users/me@x.com/q.sql":    "/Users/me@x.com/q.sql",
		" /Users/me/./a/../b.SQL ": "/Users/me/b.SQL",
	} {
		got, err := CleanRemotePath(in)
		if err != nil || got != want {
			t.Errorf("CleanRemotePath(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "Users/me/q.sql", "/", "/Users/me/q.py", `/Users\me.sql`} {
		if _, err := CleanRemotePath(bad); err == nil {
			t.Errorf("CleanRemotePath(%q) succeeded, want an error", bad)
		}
	}
}

func TestJoinName(t *testing.T) {
	got, err := JoinName("/Users/me/", "daily revenue")
	if err != nil || got != "/Users/me/daily revenue.sql" {
		t.Errorf("JoinName = %q, %v", got, err)
	}
	got, err = JoinName("/Users/me", "q.sql")
	if err != nil || got != "/Users/me/q.sql" {
		t.Errorf("JoinName = %q, %v", got, err)
	}
	for _, bad := range []string{"", "  ", "a/b", `a\b`, ".."} {
		if _, err := JoinName("/Users/me", bad); err == nil {
			t.Errorf("JoinName(%q) succeeded, want an error", bad)
		}
	}
}

func TestLocalPath(t *testing.T) {
	root := t.TempDir()
	m := New(root)
	p, err := m.LocalPath("/Users/me@x.com/a:b/q.sql")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "files", "Users", "me@x.com", "a_b", "q.sql")
	if p != want {
		t.Errorf("LocalPath = %q, want %q", p, want)
	}
	if !Within(root, p) {
		t.Errorf("%q should be within %q", p, root)
	}
	if Within(root, filepath.Dir(root)) || Within(root, root) {
		t.Error("Within accepted a path outside the folder")
	}
}

func TestIndex(t *testing.T) {
	m := New(t.TempDir())
	if _, ok, err := m.Get("/a.sql"); ok || err != nil {
		t.Fatalf("Get on an empty mirror = %v, %v", ok, err)
	}
	l := Link{RemotePath: "/Users/me/a.sql", ModifiedAt: 10, Hash: Hash("select 1"), Opened: 5}
	if err := m.Put(l); err != nil {
		t.Fatal(err)
	}
	if err := m.Put(Link{RemotePath: "/Users/me/b.sql", Opened: 9}); err != nil {
		t.Fatal(err)
	}
	local, _ := m.LocalPath(l.RemotePath)
	got, ok, err := m.Lookup(local)
	if err != nil || !ok || got != l {
		t.Fatalf("Lookup = %+v, %v, %v", got, ok, err)
	}
	recent, _ := m.Recent()
	if len(recent) != 2 || recent[0].RemotePath != "/Users/me/b.sql" {
		t.Errorf("Recent = %+v", recent)
	}
	if err := m.SetLastFolder("/Users/me"); err != nil {
		t.Fatal(err)
	}
	if f, _ := m.LastFolder(); f != "/Users/me" {
		t.Errorf("LastFolder = %q", f)
	}
}

func TestIndexKeepsNewest(t *testing.T) {
	m := New(t.TempDir())
	for i := 0; i < RecentKeep+5; i++ {
		if err := m.Put(Link{RemotePath: fmt.Sprintf("/q%d.sql", i), Opened: int64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	recent, _ := m.Recent()
	if len(recent) != RecentKeep || recent[len(recent)-1].RemotePath != "/q5.sql" {
		t.Errorf("kept %d links, oldest %q", len(recent), recent[len(recent)-1].RemotePath)
	}
}
