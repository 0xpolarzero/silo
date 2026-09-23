// sync_probe checks the Linux syscall fault injector used by the D2 experiment.
// It is intentionally independent of the E2B service and its state.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func main() {
	if len(os.Args) != 3 || (os.Args[2] != "control" && os.Args[2] != "fault") {
		fmt.Fprintln(os.Stderr, "usage: sync_probe DIR control|fault")
		os.Exit(2)
	}
	dir, mode := os.Args[1], os.Args[2]
	if err := syncFile(filepath.Join(dir, "unrelated"), false); err != nil {
		fmt.Fprintf(os.Stderr, "unrelated sync failed: %v\n", err)
		os.Exit(1)
	}
	if err := syncFile(filepath.Join(dir, "target"), mode == "fault"); err != nil {
		fmt.Fprintf(os.Stderr, "target check failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("%s: unrelated sync succeeded; target sync %s\n", mode, map[bool]string{true: "returned EIO", false: "succeeded"}[mode == "fault"])
}

func syncFile(path string, wantEIO bool) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write([]byte("D2 syscall probe\n")); err != nil {
		return err
	}
	err = f.Sync()
	if wantEIO {
		if !errors.Is(err, syscall.EIO) {
			return fmt.Errorf("wanted EIO from File.Sync, got %v", err)
		}
		return nil
	}
	return err
}
