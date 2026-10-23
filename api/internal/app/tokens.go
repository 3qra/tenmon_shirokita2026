package app

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// randomToken は推測困難なURLセーフトークン（256bit）を返す。
func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// hashToken はトークンの保存・照合用ハッシュ。用途ごとに接頭辞を変えて混用を防ぐ。
func hashToken(purpose, token string) string {
	h := sha256.Sum256([]byte(purpose + ":" + token))
	return hex.EncodeToString(h[:])
}

// deriveToken は秘密鍵と内部IDから再表示可能なトークンを導出する。
// 平文をDBに保存せずにQRを再表示するための方式（DBにはハッシュのみ保存）。
func (a *App) deriveToken(purpose, id string) string {
	m := hmac.New(sha256.New, a.Cfg.Secret)
	m.Write([]byte("derive:" + purpose + ":" + id))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// entryToken / couponToken は版つきで導出する（版0は従来どおり）。版を上げると旧QRは無効になる。
func (a *App) entryToken(ticketID string, version int) string {
	if version == 0 {
		return a.deriveToken("entry", ticketID)
	}
	return a.deriveToken("entry", fmt.Sprintf("%s:%d", ticketID, version))
}

func (a *App) couponToken(couponID string, version int) string {
	if version == 0 {
		return a.deriveToken("coupon", couponID)
	}
	return a.deriveToken("coupon", fmt.Sprintf("%s:%d", couponID, version))
}

// trimTokenURL はQRにURL形式（…/c/<token> など）で入っている場合に末尾のトークンを取り出す。
func trimTokenURL(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "/"); i >= 0 {
		s = s[i+1:]
	}
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	return s
}

// ---- パスワード（PBKDF2-SHA256） ----

const pbkdf2Iter = 210000

func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, pw, salt, pbkdf2Iter, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", pbkdf2Iter,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func checkPassword(stored, pw string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1000 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[2])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ---- 現地確認コード ----

// siteCode は部門・時間窓から3桁コードを決める。DBに保存しないため、一般APIから取得できない。
func (a *App) siteCode(deptID string, epoch int, window int64) string {
	m := hmac.New(sha256.New, a.Cfg.Secret)
	fmt.Fprintf(m, "sitecode:%s:%d:%d", deptID, epoch, window)
	n := binary.BigEndian.Uint32(m.Sum(nil)[:4]) % 1000
	return fmt.Sprintf("%03d", n)
}
