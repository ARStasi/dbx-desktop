//go:build windows

package dbcli

import (
	"os/exec"
	"syscall"
)

// hideWindow stops a console window flashing up when a GUI app runs the CLI.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
