// Package migrations はSQLマイグレーションを埋め込む。
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
