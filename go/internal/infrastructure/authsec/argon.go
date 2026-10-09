package authsec

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"regexp"
	"strconv"

	"golang.org/x/crypto/argon2"
)

// Node argon2.hash defaults with type argon2id: m=65536, t=3, p=4, hashLength=32, saltLength=16.
const (
	argonTime    = uint32(3)
	argonMemory  = uint32(65536)
	argonThreads = uint8(4)
	argonKeyLen  = uint32(32)
	argonSaltLen = 16
)

var argonRE = regexp.MustCompile(`^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$`)

func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads, b64(salt), b64(hash)), nil
}

func VerifyPassword(encoded, password string) bool {
	m := argonRE.FindStringSubmatch(encoded)
	if m == nil {
		return false
	}
	memory64, err1 := strconv.ParseUint(m[1], 10, 32)
	time64, err2 := strconv.ParseUint(m[2], 10, 32)
	threads64, err3 := strconv.ParseUint(m[3], 10, 8)
	if err1 != nil || err2 != nil || err3 != nil || threads64 == 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(m[4])
	if err != nil {
		salt, err = base64.StdEncoding.DecodeString(m[4])
		if err != nil {
			return false
		}
	}
	want, err := base64.RawStdEncoding.DecodeString(m[5])
	if err != nil {
		want, err = base64.StdEncoding.DecodeString(m[5])
		if err != nil {
			return false
		}
	}
	got := argon2.IDKey([]byte(password), salt, uint32(time64), uint32(memory64), uint8(threads64), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func b64(b []byte) string {
	return base64.RawStdEncoding.EncodeToString(b)
}
