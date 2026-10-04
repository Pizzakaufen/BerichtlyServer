//go:build linux

package httpapi

import "syscall"

// diskFreeMB liefert den freien Speicherplatz (für unprivilegierte Prozesse) in MB.
func diskFreeMB(path string) int64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return -1
	}
	return int64(st.Bavail) * int64(st.Bsize) >> 20
}
