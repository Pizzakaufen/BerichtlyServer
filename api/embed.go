// Package api enthält die OpenAPI-Spezifikation, eingebettet in die Server-Binärdatei.
package api

import _ "embed"

//go:embed openapi.yaml
var OpenAPI []byte
