package dbcli

import "testing"

func TestIsLegacy(t *testing.T) {
	cases := []struct {
		major, minor string
		want         bool
	}{
		{"0", "17", true},
		{"0", "18", true},
		{"0", "200", false},
		{"0", "295", false},
		{"1", "0", false},
		{"1", "16", false},
	}
	for _, c := range cases {
		if got := isLegacy(c.major, c.minor); got != c.want {
			t.Errorf("isLegacy(%s, %s) = %v, want %v", c.major, c.minor, got, c.want)
		}
	}
}

func TestLastLines(t *testing.T) {
	got := lastLines("a\n\n b \nc\nd\n", 2)
	if got != "c d" {
		t.Errorf("got %q", got)
	}
	if lastLines("", 3) != "" {
		t.Error("empty input should give empty output")
	}
}
