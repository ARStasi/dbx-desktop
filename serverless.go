package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"dbx-desktop/internal/nbexec"
	"dbx-desktop/internal/pykernel"
)

// Serverless notebooks run in a local Python process with Databricks Connect:
// Python state and plain Python code stay on this computer, and Spark and SQL
// run on serverless compute. Each serverless environment version needs its
// own local environment with the matching databricks-connect release, which
// the app sets up with uv when asked.

// ServerlessEnvironment describes the local environment for a serverless
// environment version.
type ServerlessEnvironment struct {
	pykernel.Env
	// Versions lists the versions that can be chosen.
	Versions []int `json:"versions"`
}

func (s *NotebookService) envStatus(version int) ServerlessEnvironment {
	if !pykernel.Supported(version) {
		version = pykernel.DefaultVersion
	}
	return ServerlessEnvironment{Env: pykernel.Status(s.pyRoot, version), Versions: pykernel.Versions()}
}

// ServerlessStatus says whether the local environment for a serverless
// environment version is set up, and whether uv is available to set it up.
func (s *NotebookService) ServerlessStatus(version int) ServerlessEnvironment {
	return s.envStatus(version)
}

// SetUpServerless creates the local environment for a serverless environment
// version: a Python virtual environment with the matching databricks-connect.
// It downloads Python and packages, so it can take a few minutes.
func (s *NotebookService) SetUpServerless(version int) (ServerlessEnvironment, error) {
	if !pykernel.Supported(version) {
		return s.envStatus(version), fmt.Errorf("serverless environment version %d is not supported", version)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	if _, err := pykernel.SetUp(ctx, s.pyRoot, version); err != nil {
		return s.envStatus(version), err
	}
	return s.envStatus(version), nil
}

// PipInstall installs packages into the local environment for a serverless
// environment version, for %pip install cells. It returns uv's output.
// Packages are local: Spark UDFs that need them on serverless compute need
// them installed there too.
func (s *NotebookService) PipInstall(version int, args string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	return pykernel.PipInstall(ctx, s.pyRoot, version, strings.Fields(args))
}

func (s *NotebookService) runServerless(profile string, version int, notebookPath, code, runID string) CellRun {
	env := s.envStatus(version)
	if !env.Ready {
		out := nbexec.Failed(fmt.Sprintf("Set up serverless environment %d on this computer first.", env.Version))
		return CellRun{Output: out, NeedsSetup: true}
	}

	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.running[runID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, runID)
		s.mu.Unlock()
		cancel()
	}()

	key := sessionKey(profile, notebookPath)
	// A notebook runs on one compute at a time; leaving a cluster ends its session.
	s.sessions.End(ctx, key)

	start := func(ctx context.Context) (*pykernel.Kernel, error) {
		return pykernel.Start(ctx, pykernel.Config{
			Python:     pykernel.PythonPath(env.Dir),
			DriverPath: filepath.Join(s.pyRoot, "driver.py"),
			Profile:    profile,
			ConfigFile: s.pool.cfgPath,
			CLIPath:    s.pool.cliPath(),
		})
	}
	spec := fmt.Sprintf("%s\x00%d", profile, env.Version)
	out, info, err := s.kernels.Run(ctx, key, spec, start, code)
	if err != nil {
		f := nbexec.Failed(cleanErr(err))
		var se *pykernel.StartError
		if errors.As(err, &se) {
			f.Detail = se.Detail
		}
		if errors.Is(err, pykernel.ErrGone) {
			f.Error = "The Python session stopped unexpectedly, so variables from earlier cells are gone. " + cleanErr(err)
		}
		return CellRun{Output: f, Started: info.Started, Lost: info.Lost}
	}
	return CellRun{Output: out, Started: info.Started, Lost: info.Lost}
}
