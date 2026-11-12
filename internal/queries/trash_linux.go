//go:build linux && !android

package queries

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

func init() { moveToTrash = xdgTrash }

// xdgTrash moves a file into the user's freedesktop.org trash, writing the
// .trashinfo file that lets file managers restore it.
func xdgTrash(path string) error {
	root := os.Getenv("XDG_DATA_HOME")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("find home folder: %w", err)
		}
		root = filepath.Join(home, ".local", "share")
	}
	trash := filepath.Join(root, "Trash")
	files, info := filepath.Join(trash, "files"), filepath.Join(trash, "info")
	for _, d := range []string{files, info} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	_, err = moveInto(files, path, func(from, to string) error {
		// Claim the name by creating its info file first.
		infoPath := filepath.Join(info, filepath.Base(to)+".trashinfo")
		f, err := os.OpenFile(infoPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, werr := fmt.Fprintf(f, "[Trash Info]\nPath=%s\nDeletionDate=%s\n",
			(&url.URL{Path: abs}).EscapedPath(), time.Now().Format("2006-01-02T15:04:05"))
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr == nil {
			if _, err := os.Lstat(to); err == nil {
				werr = os.ErrExist
			} else if errors.Is(err, os.ErrNotExist) {
				werr = os.Rename(from, to)
			} else {
				werr = err
			}
		}
		if werr != nil {
			os.Remove(infoPath)
		}
		return werr
	})
	if err != nil {
		return fmt.Errorf("could not move %s to the trash: %w", filepath.Base(path), err)
	}
	return nil
}
