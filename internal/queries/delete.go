package queries

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// moveToTrash moves a file to the system trash. It is nil on systems without
// one we can use, where Delete removes files for good.
var moveToTrash func(path string) error

// HasTrash reports whether Delete moves files to the system trash rather than
// removing them.
func HasTrash() bool { return moveToTrash != nil }

// Delete moves a query file that lives directly in dir to the trash, or
// removes it where there is no trash. Files elsewhere are refused, so a
// caller cannot be talked into deleting arbitrary paths.
func Delete(dir, path string) error {
	if err := checkSQLPath(path); err != nil {
		return err
	}
	if filepath.Clean(filepath.Dir(path)) != filepath.Clean(dir) {
		return fmt.Errorf("%s is not in the scratch folder", filepath.Base(path))
	}
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", filepath.Base(path))
	}
	if moveToTrash != nil {
		return moveToTrash(path)
	}
	return os.Remove(path)
}

// moveInto moves path into folder under its own name, or under "name 2.sql",
// "name 3.sql" and so on when that name is taken. rename must fail with an
// error matching os.ErrExist instead of replacing an existing file.
func moveInto(folder, path string, rename func(from, to string) error) (string, error) {
	base := filepath.Base(path)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 1; i < 1000; i++ {
		name := base
		if i > 1 {
			name = fmt.Sprintf("%s %d%s", stem, i, ext)
		}
		dst := filepath.Join(folder, name)
		err := rename(path, dst)
		if err == nil {
			return dst, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", err
		}
	}
	return "", fmt.Errorf("could not find a free name for %s in the trash", base)
}
