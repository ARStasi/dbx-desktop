//go:build !windows

package dbcli

import "os/exec"

func hideWindow(*exec.Cmd) {}
