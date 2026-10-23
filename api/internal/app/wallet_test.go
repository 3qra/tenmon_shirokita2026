package app

import (
	"archive/zip"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func writePEM(t *testing.T, path, typ string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}

// .pkpass の署名（PKCS#7 detached）を openssl で検証する。openssl が無ければスキップ。
func TestWalletSignature(t *testing.T) {
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("openssl not found")
	}
	dir := t.TempDir()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test WWDR"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	ca, _ := x509.ParseCertificate(caDER)
	passKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	passTpl := &x509.Certificate{SerialNumber: big.NewInt(42), Subject: pkix.Name{CommonName: "Pass Type ID: pass.test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}
	passDER, _ := x509.CreateCertificate(rand.Reader, passTpl, ca, &passKey.PublicKey, caKey)
	writePEM(t, filepath.Join(dir, "wwdr.pem"), "CERTIFICATE", caDER)
	writePEM(t, filepath.Join(dir, "cert.pem"), "CERTIFICATE", passDER)
	writePEM(t, filepath.Join(dir, "key.pem"), "RSA PRIVATE KEY", x509.MarshalPKCS1PrivateKey(passKey))

	a := New(nil, Config{Secret: []byte("x"), Wallet: WalletConfig{PassTypeID: "pass.test", TeamID: "TEAM123", OrgName: "テスト",
		CertPath: filepath.Join(dir, "cert.pem"), KeyPath: filepath.Join(dir, "key.pem"), WWDRPath: filepath.Join(dir, "wwdr.pem")}})
	pk, err := a.buildPass("tid", "20-001-1", "entry-token", "秋の星空", time.Now(), "serial1", 1)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(pk), int64(len(pk)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		var b bytes.Buffer
		b.ReadFrom(rc)
		rc.Close()
		files[f.Name] = b.Bytes()
	}
	for _, n := range []string{"pass.json", "manifest.json", "signature", "icon.png"} {
		if files[n] == nil {
			t.Fatalf("missing %s", n)
		}
	}
	os.WriteFile(filepath.Join(dir, "manifest.json"), files["manifest.json"], 0o600)
	os.WriteFile(filepath.Join(dir, "signature"), files["signature"], 0o600)
	out, err := exec.Command("openssl", "smime", "-verify", "-binary", "-inform", "DER", "-in", filepath.Join(dir, "signature"),
		"-content", filepath.Join(dir, "manifest.json"), "-CAfile", filepath.Join(dir, "wwdr.pem"), "-purpose", "any", "-out", os.DevNull).CombinedOutput()
	if err != nil {
		t.Fatalf("openssl verify failed: %v\n%s", err, out)
	}
}
