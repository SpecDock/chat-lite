package httpapi

import (
	"fmt"
	"strings"
)

func placeholders(n, start int) string {
	parts := make([]string, n)
	for i := 0; i < n; i++ {
		parts[i] = fmt.Sprintf("$%d", start+i)
	}
	return strings.Join(parts, ",")
}
