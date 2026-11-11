// Package sealed wraps an export so that only someone with the passphrase can
// read it. An export holds a whole memory; it is never written in the clear.
package sealed

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
)

// magic opens every sealed file and is bound into the encryption.
const magic = "ZIWO-EXPORT-1\n"

const (
	saltLen    = 16
	iterations = 600_000
	// MinPassphrase is the shortest passphrase Seal accepts.
	MinPassphrase = 12
)

// ErrWrongKey is returned when a sealed file does not open: the passphrase is
// wrong, or the file was changed.
var ErrWrongKey = errors.New("wrong passphrase, or the file was changed")

func aead(passphrase string, salt []byte) (cipher.AEAD, error) {
	key, err := pbkdf2.Key(sha256.New, passphrase, salt, iterations, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal compresses plain and encrypts it under the passphrase.
func Seal(plain []byte, passphrase string) ([]byte, error) {
	if len(passphrase) < MinPassphrase {
		return nil, fmt.Errorf("the passphrase must be at least %d characters", MinPassphrase)
	}
	var packed bytes.Buffer
	zw := gzip.NewWriter(&packed)
	if _, err := zw.Write(plain); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	gcm, err := aead(passphrase, salt)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := append([]byte(magic), salt...)
	out = append(out, nonce...)
	return gcm.Seal(out, nonce, packed.Bytes(), []byte(magic)), nil
}

// Open reverses Seal.
func Open(sealed []byte, passphrase string) ([]byte, error) {
	if !bytes.HasPrefix(sealed, []byte(magic)) {
		return nil, errors.New("not a ziwo export")
	}
	rest := sealed[len(magic):]
	if len(rest) < saltLen {
		return nil, ErrWrongKey
	}
	gcm, err := aead(passphrase, rest[:saltLen])
	if err != nil {
		return nil, err
	}
	rest = rest[saltLen:]
	if len(rest) < gcm.NonceSize() {
		return nil, ErrWrongKey
	}
	packed, err := gcm.Open(nil, rest[:gcm.NonceSize()], rest[gcm.NonceSize():], []byte(magic))
	if err != nil {
		return nil, ErrWrongKey
	}
	zr, err := gzip.NewReader(bytes.NewReader(packed))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(zr)
}
