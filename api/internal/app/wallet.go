package app

import (
	"archive/zip"
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/asn1"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math/big"
	"net/http"
	"os"
	"sort"
	"strconv"
	"time"
)

// Apple Wallet（.pkpass）発行。証明書・秘密鍵はサーバーの環境変数で指定したファイルから読む。
// リポジトリやアプリには含めない。Wallet発行に失敗しても予約は成立したまま（Web QRで入場可能）。

func (a *App) walletEnabled() bool {
	c := a.Cfg.Wallet
	return c.PassTypeID != "" && c.TeamID != "" && c.CertPath != "" && c.KeyPath != "" && c.WWDRPath != ""
}

type walletSigner struct {
	cert *x509.Certificate
	key  crypto.Signer
	wwdr *x509.Certificate
}

func loadPEMCert(path string) (*x509.Certificate, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			return nil, fmt.Errorf("%s: 証明書が見つかりません", path)
		}
		if blk.Type == "CERTIFICATE" {
			return x509.ParseCertificate(blk.Bytes)
		}
	}
}

func loadPEMKey(path string) (crypto.Signer, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			return nil, fmt.Errorf("%s: 秘密鍵が見つかりません", path)
		}
		switch blk.Type {
		case "RSA PRIVATE KEY":
			return x509.ParsePKCS1PrivateKey(blk.Bytes)
		case "EC PRIVATE KEY":
			return x509.ParseECPrivateKey(blk.Bytes)
		case "PRIVATE KEY":
			k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
			if err != nil {
				return nil, err
			}
			if s, ok := k.(crypto.Signer); ok {
				return s, nil
			}
			return nil, errors.New("未対応の秘密鍵形式です")
		}
	}
}

func (a *App) walletSigner() (*walletSigner, error) {
	c := a.Cfg.Wallet
	cert, err := loadPEMCert(c.CertPath)
	if err != nil {
		return nil, err
	}
	key, err := loadPEMKey(c.KeyPath)
	if err != nil {
		return nil, err
	}
	wwdr, err := loadPEMCert(c.WWDRPath)
	if err != nil {
		return nil, err
	}
	return &walletSigner{cert: cert, key: key, wwdr: wwdr}, nil
}

// ---- 最小限の DER/PKCS#7 実装（detached SignedData） ----

func derLen(n int) []byte {
	if n < 0x80 {
		return []byte{byte(n)}
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte(n & 0xff)}, b...)
		n >>= 8
	}
	return append([]byte{0x80 | byte(len(b))}, b...)
}

func tlv(tag byte, parts ...[]byte) []byte {
	content := bytes.Join(parts, nil)
	return append(append([]byte{tag}, derLen(len(content))...), content...)
}

func derSeq(parts ...[]byte) []byte { return tlv(0x30, parts...) }

// derSet は DER の SET OF（要素を辞書順に整列）。
func derSet(parts ...[]byte) []byte {
	s := append([][]byte{}, parts...)
	sort.Slice(s, func(i, j int) bool { return bytes.Compare(s[i], s[j]) < 0 })
	return tlv(0x31, s...)
}

func derOID(oid asn1.ObjectIdentifier) []byte {
	b, _ := asn1.Marshal(oid)
	return b
}

func derInt(n *big.Int) []byte {
	b, _ := asn1.Marshal(n)
	return b
}

var (
	oidData          = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 1}
	oidSignedData    = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2}
	oidContentType   = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 3}
	oidMessageDigest = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 4}
	oidSigningTime   = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 5}
	oidSHA256        = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}
	oidRSA           = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	oidECDSASHA256   = asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 2}
)

func (ws *walletSigner) signDetached(content []byte, now time.Time) ([]byte, error) {
	digest := sha256.Sum256(content)
	tm, _ := asn1.MarshalWithParams(now.UTC(), "utc")
	attrs := [][]byte{
		derSeq(derOID(oidContentType), derSet(derOID(oidData))),
		derSeq(derOID(oidSigningTime), derSet(tm)),
		derSeq(derOID(oidMessageDigest), derSet(tlv(0x04, digest[:]))),
	}
	attrSet := derSet(attrs...) // 署名対象は SET（0x31）としてエンコードしたもの
	h := sha256.Sum256(attrSet)
	var sig []byte
	var sigAlg []byte
	var err error
	switch k := ws.key.(type) {
	case *rsa.PrivateKey:
		sig, err = rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, h[:])
		sigAlg = derSeq(derOID(oidRSA), []byte{0x05, 0x00})
	case *ecdsa.PrivateKey:
		sig, err = ecdsa.SignASN1(rand.Reader, k, h[:])
		sigAlg = derSeq(derOID(oidECDSASHA256))
	default:
		return nil, errors.New("未対応の鍵種別です")
	}
	if err != nil {
		return nil, err
	}
	// [0] IMPLICIT に付け替え
	signedAttrs := append([]byte{0xA0}, attrSet[1:]...)
	digestAlg := derSeq(derOID(oidSHA256), []byte{0x05, 0x00})
	signerInfo := derSeq(
		derInt(big.NewInt(1)),
		derSeq(ws.cert.RawIssuer, derInt(ws.cert.SerialNumber)),
		digestAlg,
		signedAttrs,
		sigAlg,
		tlv(0x04, sig),
	)
	certs := tlv(0xA0, ws.cert.Raw, ws.wwdr.Raw)
	signedData := derSeq(
		derInt(big.NewInt(1)),
		derSet(digestAlg),
		derSeq(derOID(oidData)),
		certs,
		derSet(signerInfo),
	)
	return derSeq(derOID(oidSignedData), tlv(0xA0, signedData)), nil
}

// passIcon は簡易アイコン（星形の点）を生成する。正式なデザインに差し替える場合は画像ファイルを用意する。
func passIcon(size int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	bg := color.RGBA{0x14, 0x1a, 0x3a, 0xff}
	fg := color.RGBA{0xf5, 0xd7, 0x6e, 0xff}
	c := float64(size) / 2
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx, dy := float64(x)-c, float64(y)-c
			d := dx*dx + dy*dy
			if d < (c*0.35)*(c*0.35) {
				img.Set(x, y, fg)
			} else {
				img.Set(x, y, bg)
			}
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

// buildPass は1枚の入場チケットの .pkpass を作る。
func (a *App) buildPass(ticketID, ticketNo, entryToken, title string, starts time.Time, serial string, version int) ([]byte, error) {
	ws, err := a.walletSigner()
	if err != nil {
		return nil, err
	}
	c := a.Cfg.Wallet
	pass := map[string]any{
		"formatVersion":      1,
		"passTypeIdentifier": c.PassTypeID,
		"serialNumber":       serial,
		"teamIdentifier":     c.TeamID,
		"organizationName":   c.OrgName,
		"description":        title + " 入場チケット",
		"logoText":           c.OrgName,
		"foregroundColor":    "rgb(255,255,255)",
		"backgroundColor":    "rgb(20,26,58)",
		"labelColor":         "rgb(245,215,110)",
		"relevantDate":       starts.Format(time.RFC3339),
		"expirationDate":     starts.Add(3 * time.Hour).Format(time.RFC3339),
		"barcodes": []map[string]any{{
			"format": "PKBarcodeFormatQR", "message": entryToken, "messageEncoding": "iso-8859-1", "altText": ticketNo,
		}},
		"eventTicket": map[string]any{
			"primaryFields":   []map[string]any{{"key": "title", "label": "上映", "value": title}},
			"secondaryFields": []map[string]any{{"key": "time", "label": "開始", "value": starts.In(jst).Format("1/2 15:04")}},
			"auxiliaryFields": []map[string]any{{"key": "venue", "label": "会場", "value": c.VenueName},
				{"key": "ticket", "label": "チケット番号", "value": ticketNo}},
			"backFields": []map[string]any{{"key": "note", "label": "ご案内",
				"value": "入場時にこのQRコードをスタッフに提示してください。上映の中止・変更は予約確認ページで最新の状態をご確認ください。"}},
		},
	}
	passJSON, err := json.Marshal(pass)
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{
		"pass.json":   passJSON,
		"icon.png":    passIcon(29),
		"icon@2x.png": passIcon(58),
		"icon@3x.png": passIcon(87),
		"logo.png":    passIcon(50),
		"logo@2x.png": passIcon(100),
	}
	manifest := map[string]string{}
	for name, b := range files {
		h := sha1.Sum(b)
		manifest[name] = hex.EncodeToString(h[:])
	}
	manifestJSON, _ := json.Marshal(manifest)
	sig, err := ws.signDetached(manifestJSON, a.Now())
	if err != nil {
		return nil, err
	}
	files["manifest.json"] = manifestJSON
	files["signature"] = sig
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		f, err := zw.Create(n)
		if err != nil {
			return nil, err
		}
		f.Write(files[n])
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// GET /api/v1/public/reservations/by-token/{token}/tickets/{seq}/wallet
// GETはパスを返すだけで、予約取消や入場確定は行わない。
func (a *App) handleWalletPass(w http.ResponseWriter, r *http.Request) error {
	if !a.walletEnabled() {
		return errf(503, "wallet_disabled", "Apple Walletは現在利用できません。予約確認ページのQRコードで入場できます")
	}
	if err := a.rateLimit(r, "wallet", 30, 10); err != nil {
		return err
	}
	ctx := r.Context()
	resID, err := a.reservationIDByToken(ctx, a.DB, r.PathValue("token"), false)
	if err != nil {
		return err
	}
	seq, err := strconv.Atoi(r.PathValue("seq"))
	if err != nil {
		return notFound("チケット")
	}
	var ticketID, ticketNo, title, status, rvStatus string
	var starts time.Time
	var tver int
	err = a.DB.QueryRowContext(ctx, `SELECT t.id, t.public_no, s.title, s.starts_at, t.status, rv.status, t.token_version FROM admission_tickets t
		JOIN reservations rv ON rv.id=t.reservation_id JOIN screenings s ON s.id=t.screening_id
		WHERE t.reservation_id=$1 AND t.seq=$2`, resID, seq).Scan(&ticketID, &ticketNo, &title, &starts, &status, &rvStatus, &tver)
	if err == sql.ErrNoRows {
		return notFound("チケット")
	}
	if err != nil {
		return err
	}
	if status != "valid" || rvStatus != "confirmed" {
		return conflict("ticket_void", "このチケットは取り消されています")
	}
	var serial string
	var version int
	err = a.DB.QueryRowContext(ctx, `INSERT INTO wallet_passes(ticket_id, serial) VALUES ($1, encode(gen_random_bytes(12),'hex'))
		ON CONFLICT (ticket_id) DO UPDATE SET updated_at=now() RETURNING serial, version`, ticketID).Scan(&serial, &version)
	if err != nil {
		return err
	}
	pkpass, err := a.buildPass(ticketID, ticketNo, a.entryToken(ticketID, tver), title, starts, serial, version)
	if err != nil {
		return fmt.Errorf("wallet: %w", err)
	}
	w.Header().Set("Content-Type", "application/vnd.apple.pkpass")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="ticket-%s.pkpass"`, ticketNo))
	w.Header().Set("Cache-Control", "no-store")
	w.Write(pkpass)
	return nil
}
