package pykernel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Serverless environment versions and the Databricks Connect release and
// Python version each needs, from Databricks' compatibility table.
var connectFor = map[int]struct {
	Spec   string
	Python string
}{
	2: {"databricks-connect>=15.4.10,<16", "3.11"},
	3: {"databricks-connect>=16.4.1,<17", "3.12"},
	4: {"databricks-connect>=17.3,<17.4", "3.12"},
	5: {"databricks-connect>=18.0,<18.4", "3.12"},
}

// DefaultVersion is the serverless environment version used unless the user
// picks another.
const DefaultVersion = 4

// Versions lists the serverless environment versions the app can set up.
func Versions() []int { return []int{3, 4, 5, 2} }

// Supported reports whether v is a serverless environment version the app
// knows how to set up.
func Supported(v int) bool {
	_, ok := connectFor[v]
	return ok
}

// Env is a local Python environment for one serverless environment version.
type Env struct {
	Version int    `json:"version"`
	Dir     string `json:"dir"`
	// Ready is true once the environment has been set up.
	Ready bool `json:"ready"`
	// Python and Connect are the installed versions, when Ready.
	Python  string `json:"python"`
	Connect string `json:"connect"`
	// UV is the uv executable used to set it up, or "" when uv is missing.
	UV string `json:"uv"`
	// InstallUV holds commands that install uv on this system.
	InstallUV []string `json:"installUv"`
}

type marker struct {
	Spec    string `json:"spec"`
	Python  string `json:"python"`
	Connect string `json:"connect"`
}

// EnvDir is where the environment for version v lives under root.
func EnvDir(root string, v int) string {
	return filepath.Join(root, fmt.Sprintf("serverless-v%d", v))
}

// PythonPath is the interpreter inside an environment folder.
func PythonPath(dir string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(dir, "Scripts", "python.exe")
	}
	return filepath.Join(dir, "bin", "python")
}

func markerPath(dir string) string { return filepath.Join(dir, "dbx-desktop.json") }

// Status describes the environment for version v under root.
func Status(root string, v int) Env {
	dir := EnvDir(root, v)
	e := Env{Version: v, Dir: dir, UV: FindUV(), InstallUV: installHelp()}
	b, err := os.ReadFile(markerPath(dir))
	if err != nil {
		return e
	}
	var m marker
	if json.Unmarshal(b, &m) != nil || m.Spec != connectFor[v].Spec {
		return e
	}
	if _, err := os.Stat(PythonPath(dir)); err != nil {
		return e
	}
	e.Ready, e.Python, e.Connect = true, m.Python, m.Connect
	return e
}

// FindUV returns the uv executable, or "" when it is not installed.
func FindUV() string {
	if p, err := exec.LookPath("uv"); err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	name := "uv"
	if runtime.GOOS == "windows" {
		name = "uv.exe"
	}
	for _, dir := range []string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".cargo", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func installHelp() []string {
	if runtime.GOOS == "windows" {
		return []string{
			"winget install --id=astral-sh.uv -e",
			`powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`,
		}
	}
	return []string{"brew install uv", "curl -LsSf https://astral.sh/uv/install.sh | sh"}
}

// SetUp creates the environment for version v under root with uv: a
// virtual environment on the matching Python, with databricks-connect and
// matplotlib. uv downloads Python when it is not installed.
func SetUp(ctx context.Context, root string, v int) (Env, error) {
	c, ok := connectFor[v]
	if !ok {
		return Env{}, fmt.Errorf("serverless environment version %d is not supported", v)
	}
	uv := FindUV()
	if uv == "" {
		return Status(root, v), errors.New("uv is not installed")
	}
	dir := EnvDir(root, v)
	_ = os.Remove(markerPath(dir))
	if err := os.MkdirAll(root, 0o755); err != nil {
		return Status(root, v), err
	}
	if _, err := runUV(ctx, uv, "venv", "--python", c.Python, "--allow-existing", dir); err != nil {
		return Status(root, v), err
	}
	py := PythonPath(dir)
	if _, err := runUV(ctx, uv, "pip", "install", "--python", py, c.Spec, "matplotlib"); err != nil {
		return Status(root, v), err
	}
	out, err := exec.CommandContext(ctx, py, "-c",
		"import sys, importlib.metadata as m; print(sys.version.split()[0]); print(m.version('databricks-connect'))").Output()
	if err != nil {
		return Status(root, v), fmt.Errorf("the new environment does not work: %w", err)
	}
	lines := strings.Fields(string(out))
	m := marker{Spec: c.Spec}
	if len(lines) >= 2 {
		m.Python, m.Connect = lines[0], lines[1]
	}
	b, _ := json.Marshal(m)
	if err := os.WriteFile(markerPath(dir), b, 0o644); err != nil {
		return Status(root, v), err
	}
	return Status(root, v), nil
}

// PipInstall installs packages into the environment for version v. args are
// what follows "%pip install" in a cell.
func PipInstall(ctx context.Context, root string, v int, args []string) (string, error) {
	e := Status(root, v)
	if !e.Ready {
		return "", errors.New("set up serverless first")
	}
	if e.UV == "" {
		return "", errors.New("uv is not installed")
	}
	if len(args) == 0 {
		return "", errors.New("name the packages to install, as in %pip install faker")
	}
	for _, a := range args {
		if strings.HasPrefix(a, "-") && a != "-U" && a != "--upgrade" && a != "-q" && a != "--quiet" {
			return "", fmt.Errorf("%s is not supported here; only package names, -U and -q are", a)
		}
	}
	full := []string{"pip", "install", "--python", PythonPath(e.Dir)}
	for _, a := range args {
		if a != "-q" && a != "--quiet" {
			full = append(full, a)
		}
	}
	return runUV(ctx, e.UV, full...)
}

func runUV(ctx context.Context, uv string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, uv, args...)
	cmd.Env = append(os.Environ(), "UV_NO_PROGRESS=1")
	hideWindow(cmd)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(out.String())
		if len(msg) > 2000 {
			msg = "…" + msg[len(msg)-2000:]
		}
		if msg == "" {
			msg = err.Error()
		}
		return msg, fmt.Errorf("uv %s failed: %s", args[0], msg)
	}
	return out.String(), nil
}
