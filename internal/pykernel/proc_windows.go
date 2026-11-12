//go:build windows

package pykernel

import (
	"os/exec"
	"syscall"
)

// hideWindow stops a console window opening for the Python process.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
