//go:build !linux

package httpapi

// diskFreeMB ist außerhalb von Linux (nur Entwicklung) nicht implementiert: -1 = unbekannt.
func diskFreeMB(string) int64 { return -1 }
