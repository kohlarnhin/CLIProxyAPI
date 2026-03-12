package tokenpanelasset

import (
	"embed"
	"fmt"
	"mime"
	"path/filepath"
	"strings"
)

//go:embed assets/*
var assetFS embed.FS

func IndexHTML() ([]byte, error) {
	return assetFS.ReadFile("assets/index.html")
}

func Asset(path string) ([]byte, string, error) {
	cleaned := strings.TrimSpace(path)
	cleaned = strings.TrimPrefix(cleaned, "/")
	if cleaned == "" {
		return nil, "", fmt.Errorf("empty asset path")
	}

	fullPath := filepath.ToSlash(filepath.Join("assets", cleaned))
	if !strings.HasPrefix(fullPath, "assets/") {
		return nil, "", fmt.Errorf("invalid asset path")
	}

	data, err := assetFS.ReadFile(fullPath)
	if err != nil {
		return nil, "", err
	}

	contentType := mime.TypeByExtension(filepath.Ext(fullPath))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	return data, contentType, nil
}
