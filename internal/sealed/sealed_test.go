package sealed

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestSealAndOpen(t *testing.T) {
	plain := []byte(strings.Repeat("用户给我看了他的猫 plainmark7q\n", 200))
	const pass = "correct horse battery"
	box, err := Seal(plain, pass)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(box, []byte("plainmark7q")) || bytes.Contains(box, []byte("猫")) {
		t.Error("the sealed file holds the text in the clear")
	}
	if got, err := Open(box, pass); err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("open with the right passphrase: %d bytes, %v", len(got), err)
	}
	again, _ := Seal(plain, pass)
	if bytes.Equal(again, box) {
		t.Error("sealing the same thing twice gives the same bytes")
	}

	if _, err := Open(box, "correct horse batterx"); !errors.Is(err, ErrWrongKey) {
		t.Errorf("wrong passphrase: %v", err)
	}
	for _, at := range []int{len(magic) + 3, len(box) / 2} { // in the salt, and in the sealed text
		bad := append([]byte(nil), box...)
		bad[at] ^= 1
		if _, err := Open(bad, pass); !errors.Is(err, ErrWrongKey) {
			t.Errorf("a file changed at byte %d opened: %v", at, err)
		}
	}
	if _, err := Open(box[:len(box)-10], pass); !errors.Is(err, ErrWrongKey) {
		t.Errorf("a file cut short opened: %v", err)
	}
	if _, err := Open([]byte("SQLite format 3\x00 something else"), pass); err == nil || errors.Is(err, ErrWrongKey) {
		t.Errorf("a file that is not an export: %v", err)
	}
	if _, err := Seal(plain, "short"); err == nil {
		t.Error("a passphrase of five characters was accepted")
	}
}
