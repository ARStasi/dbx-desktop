package main

import (
	"errors"
	"slices"
	"testing"

	"dbx-desktop/internal/dbcfg"
)

func TestResolveActive(t *testing.T) {
	profiles := []dbcfg.Profile{
		{Name: "acct", IsAccount: true},
		{Name: "dev"},
		{Name: "prod", IsDefault: true},
	}
	cases := []struct {
		name, saved, want string
		profiles          []dbcfg.Profile
	}{
		{"saved profile wins", "dev", "dev", profiles},
		{"missing saved falls back to CLI default", "gone", "prod", profiles},
		{"account profile is never active", "acct", "prod", profiles},
		{"no default falls back to first workspace", "", "dev", profiles[:2]},
		{"no workspaces", "", "", profiles[:1]},
	}
	for _, c := range cases {
		if got := resolveActive(c.saved, c.profiles); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestDefaultColorIsStableAndInPalette(t *testing.T) {
	for _, name := range []string{"DEFAULT", "prod", "a-very-long-profile-name", ""} {
		c := defaultColor(name)
		if !slices.Contains(Palette, c) {
			t.Errorf("defaultColor(%q) = %q, not in the palette", name, c)
		}
		if c != defaultColor(name) {
			t.Errorf("defaultColor(%q) is not stable", name)
		}
	}
}

func TestCleanErr(t *testing.T) {
	cases := map[string]string{
		"default auth: cannot get access token: A new access token could not be retrieved because the refresh token is invalid. To reauthenticate, run the following command:\n $ databricks auth login": "The saved sign-in for this workspace has expired.",
		`Get "https://x/api": dial tcp: lookup x: no such host`: "The workspace host could not be found. Check the URL and your network connection.",
		"first line\nsecond line":                               "first line",
	}
	for in, want := range cases {
		if got := cleanErr(errors.New(in)); got != want {
			t.Errorf("cleanErr(%q) = %q, want %q", in, got, want)
		}
	}
}
