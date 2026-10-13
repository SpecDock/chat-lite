package authsec

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"regexp"
	"strconv"
	"strings"

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

var argonParamRE = regexp.MustCompile(`^(m|t|p)=(\d+)$`)

func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads, b64(salt), b64(hash)), nil
}

func VerifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var memory64, time64, threads64 uint64
	seen := map[string]bool{}
	for _, item := range strings.Split(parts[3], ",") {
		match := argonParamRE.FindStringSubmatch(item)
		if match == nil {
			return false
		}
		value, err := strconv.ParseUint(match[2], 10, 32)
		if err != nil || seen[match[1]] {
			return false
		}
		seen[match[1]] = true
		switch match[1] {
		case "m":
			memory64 = value
		case "t":
			time64 = value
		case "p":
			threads64 = value
		}
	}
	if !seen["m"] || !seen["t"] || !seen["p"] || threads64 == 0 || time64 == 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		salt, err = base64.StdEncoding.DecodeString(parts[4])
		if err != nil {
			return false
		}
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		want, err = base64.StdEncoding.DecodeString(parts[5])
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
