package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lib/pq"
)

// APIError は利用者に返すエラー。Code は機械判定用、Message は表示用（日本語）。
type APIError struct {
	Status  int            `json:"-"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

func errf(status int, code, format string, args ...any) *APIError {
	return &APIError{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

func badRequest(format string, args ...any) *APIError {
	return errf(http.StatusBadRequest, "bad_request", format, args...)
}
func notFound(what string) *APIError {
	return errf(http.StatusNotFound, "not_found", "%sが見つかりません", what)
}
func conflict(code, format string, args ...any) *APIError {
	return errf(http.StatusConflict, code, format, args...)
}
func forbidden(format string, args ...any) *APIError {
	return errf(http.StatusForbidden, "forbidden", format, args...)
}
func unprocessable(code, format string, args ...any) *APIError {
	return errf(http.StatusUnprocessableEntity, code, format, args...)
}

var errUnauthorized = errf(http.StatusUnauthorized, "unauthorized", "ログインが必要です")

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// toAPIError はDBエラー等を利用者向けエラーに変換する。
func toAPIError(err error) *APIError {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae
	}
	if errors.Is(err, sql.ErrNoRows) {
		return notFound("対象")
	}
	var pe *pq.Error
	if errors.As(err, &pe) {
		switch pe.Code {
		case "23505":
			return conflict("duplicate", "既に登録されています")
		case "23514":
			return errf(http.StatusBadRequest, "invalid_value", "入力値が正しくないか、条件を満たさないため処理できません（%s）", pe.Constraint)
		case "23P01":
			return conflict("overlap", "時間帯が他の枠と重複しています")
		case "23503":
			return badRequest("参照先が存在しません")
		case "22P02":
			return badRequest("IDの形式が正しくありません")
		case "40001", "40P01":
			return conflict("retry", "混み合っています。もう一度お試しください")
		}
	}
	return nil
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	ae := toAPIError(err)
	if ae == nil {
		slog.Error("internal error", "err", err, "path", r.URL.Path, "method", r.Method)
		ae = errf(http.StatusInternalServerError, "internal", "サーバーでエラーが発生しました")
	}
	writeJSON(w, ae.Status, map[string]any{"error": ae})
}

// handler はエラーを返せるハンドラ。
type handler func(w http.ResponseWriter, r *http.Request) error

func (h handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := h(w, r); err != nil {
		writeError(w, r, err)
	}
}

func decodeJSON(r *http.Request, v any) error {
	if r.Body == nil {
		return badRequest("リクエスト本文がありません")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return badRequest("リクエストを読み取れません")
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		body = []byte("{}")
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return badRequest("リクエストの形式が正しくありません: %v", err)
	}
	return nil
}

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func queryDate(r *http.Request, key string) (string, error) {
	v := r.URL.Query().Get(key)
	if v == "" {
		return "", nil
	}
	if _, err := time.Parse("2006-01-02", v); err != nil {
		return "", badRequest("日付の形式が正しくありません（YYYY-MM-DD）")
	}
	return v, nil
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}

func pathID(r *http.Request, name string) (string, error) {
	v := r.PathValue(name)
	if !isUUID(v) {
		return "", notFound("対象")
	}
	return strings.ToLower(v), nil
}

func requireText(field, v string, max int) error {
	v = strings.TrimSpace(v)
	if v == "" {
		return badRequest("%sを入力してください", field)
	}
	if len([]rune(v)) > max {
		return badRequest("%sは%d文字以内で入力してください", field, max)
	}
	return nil
}

// nullStr は空文字をNULLとして扱う。
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[0])
		}
		if xr := r.Header.Get("X-Real-IP"); xr != "" {
			return xr
		}
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}
