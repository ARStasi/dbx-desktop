//go:build !windows

package pykernel

import "os/exec"

func hideWindow(*exec.Cmd) {}
