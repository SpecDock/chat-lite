//go:build !linux

package main

import "errors"

func prepareQuota(root, id string) error {
	return errors.New("sandbox project quotas require Linux XFS")
}
