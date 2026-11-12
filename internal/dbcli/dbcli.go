// Package dbcli finds the Databricks CLI and runs its browser login.
package dbcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Info describes the Databricks CLI found on this machine.
type Info struct {
	Found   bool   `json:"found"`
	Path    string `json:"path"`
	Version string `json:"version"`
	// Legacy is true for the old Python CLI (0.17 and earlier), which cannot
	// do browser login.
	Legacy bool `json:"legacy"`
	// InstallHelp lists commands that install the CLI on this OS.
	InstallHelp []InstallStep `json:"installHelp"`
}

// InstallStep is one way to install the CLI.
type InstallStep struct {
	Label   string `json:"label"`
	Command string `json:"command"`
}

var versionRe = regexp.MustCompile(`v?(\d+)\.(\d+)\.(\d+)`)

// Detect looks for the CLI on PATH and in the usual install locations. Apps
// started from Finder or the Start menu get a short PATH, so PATH alone is
// not enough.
func Detect(ctx context.Context) Info {
	info := Info{InstallHelp: installHelp()}
	path := find()
	if path == "" {
		return info
	}
	info.Found = true
	info.Path = path

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// The legacy CLI has no "version" subcommand.
		cmd = exec.CommandContext(ctx, path, "--version")
		hideWindow(cmd)
		out, _ = cmd.CombinedOutput()
	}
	if m := versionRe.FindStringSubmatch(string(out)); m != nil {
		info.Version = m[1] + "." + m[2] + "." + m[3]
		info.Legacy = isLegacy(m[1], m[2])
	}
	return info
}

// isLegacy reports whether a version belongs to the old Python CLI. The
// current Go CLI started at 0.200.
func isLegacy(major, minor string) bool {
	mi, err := strconv.Atoi(minor)
	return major == "0" && err == nil && mi < 200
}

func find() string {
	if p := os.Getenv("DATABRICKS_CLI_PATH"); p != "" {
		if isFile(p) {
			return p
		}
	}
	if p, err := exec.LookPath("databricks"); err == nil {
		return p
	}
	for _, p := range candidates() {
		if isFile(p) {
			return p
		}
	}
	return ""
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func candidates() []string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		local := os.Getenv("LOCALAPPDATA")
		pf := os.Getenv("ProgramFiles")
		return []string{
			filepath.Join(local, "Microsoft", "WinGet", "Links", "databricks.exe"),
			filepath.Join(pf, "Databricks", "databricks.exe"),
			filepath.Join(home, "scoop", "shims", "databricks.exe"),
			filepath.Join(os.Getenv("ProgramData"), "chocolatey", "bin", "databricks.exe"),
		}
	}
	return []string{
		"/opt/homebrew/bin/databricks",
		"/usr/local/bin/databricks",
		"/home/linuxbrew/.linuxbrew/bin/databricks",
		filepath.Join(home, ".local", "bin", "databricks"),
		filepath.Join(home, "bin", "databricks"),
	}
}

func installHelp() []InstallStep {
	switch runtime.GOOS {
	case "windows":
		return []InstallStep{
			{Label: "WinGet", Command: "winget install Databricks.DatabricksCLI"},
		}
	case "darwin":
		return []InstallStep{
			{Label: "Homebrew", Command: "brew tap databricks/tap && brew install databricks"},
		}
	default:
		return []InstallStep{
			{Label: "Install script", Command: "curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh"},
		}
	}
}

// Login runs `databricks auth login` for a host and profile. The CLI opens
// the browser, waits for sign-in, and writes the profile to the config file.
// Cancel ctx to abandon a login the user walked away from.
func Login(ctx context.Context, cliPath, configFile, host, profile string) error {
	if cliPath == "" {
		return errors.New("the Databricks CLI is not installed")
	}
	// The CLI's own timeout makes it exit cleanly; the context is the backstop.
	cmd := exec.CommandContext(ctx, cliPath, "auth", "login",
		"--host", host, "--profile", profile, "--timeout", "5m")
	cmd.Env = append(os.Environ(), "DATABRICKS_CONFIG_FILE="+configFile)
	hideWindow(cmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	if ctx.Err() != nil {
		return errors.New("sign-in was cancelled")
	}
	if err != nil {
		msg := lastLines(out.String(), 3)
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("sign-in failed: %s", msg)
	}
	return nil
}

func lastLines(s string, n int) string {
	lines := []string{}
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " ")
}
