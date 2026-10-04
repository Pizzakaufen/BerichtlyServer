package api

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// Jede in routes_v1.go registrierte Route muss in der OpenAPI-Spezifikation dokumentiert sein.
func TestOpenAPIDokumentiertAlleRouten(t *testing.T) {
	var spec struct {
		Info  struct{ Version string }
		Paths map[string]map[string]any
	}
	if err := yaml.Unmarshal(OpenAPI, &spec); err != nil {
		t.Fatal("openapi.yaml ist kein gültiges YAML:", err)
	}
	version, _ := os.ReadFile("../VERSION")
	if spec.Info.Version != strings.TrimSpace(string(version)) {
		t.Fatalf("OpenAPI-Version %q passt nicht zu VERSION %q", spec.Info.Version, strings.TrimSpace(string(version)))
	}
	src, err := os.ReadFile("../internal/httpapi/routes_v1.go")
	if err != nil {
		t.Fatal(err)
	}
	routes := regexp.MustCompile(`"(GET|POST|PUT|PATCH|DELETE) "\+v1\+"([^"]+)"`).FindAllStringSubmatch(string(src), -1)
	if len(routes) < 30 {
		t.Fatalf("nur %d Routen gefunden", len(routes))
	}
	for _, r := range routes {
		path := "/api/v1" + r[2]
		ops, ok := spec.Paths[path]
		if !ok {
			t.Errorf("Pfad fehlt in openapi.yaml: %s", path)
			continue
		}
		if _, ok := ops[strings.ToLower(r[1])]; !ok {
			t.Errorf("Methode %s fehlt für %s", r[1], path)
		}
	}
}
