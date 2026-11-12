//go:build darwin

package queries

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func init() { moveToTrash = macTrash }

// macTrash moves a file into ~/.Trash. The rename refuses to replace an
// existing file, because the Trash folder usually cannot be listed without
// Full Disk Access, so checking for a name clash first would not work.
func macTrash(path string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("find home folder: %w", err)
	}
	_, err = moveInto(filepath.Join(home, ".Trash"), path, func(from, to string) error {
		if err := unix.RenamexNp(from, to, unix.RENAME_EXCL); err != nil {
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("could not move %s to the Trash: %w", filepath.Base(path), err)
	}
	return nil
}
