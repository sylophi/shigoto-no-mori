//go:build !darwin

package main

// No per-file private size off macOS: btrfs and XFS reflinks can't be
// told apart from a stat, so a reflinked file counts in full.
func privateSize(string) (int64, bool) { return 0, false }
