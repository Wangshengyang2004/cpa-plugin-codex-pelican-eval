#!/bin/sh
# Builds the Linux amd64 plugin in a Go container; output goes to dist/.
set -eu
cd "$(dirname "$0")"
docker run --rm -v "$PWD:/src" -w /src -e GOFLAGS=-buildvcs=false golang:1.24-bookworm sh -c '
  test -z "$(gofmt -l .)" || { gofmt -l .; echo "run gofmt -w ." >&2; exit 1; }
  go vet ./...
  go test -race -count=1 ./...
  go build -trimpath -ldflags="-s -w" -tags cshared -buildmode=c-shared \
    -o dist/cpa-codex-pelican-eval.so ./cmd/cpa-codex-pelican-eval
  rm -f dist/cpa-codex-pelican-eval.h'
ls -l dist/cpa-codex-pelican-eval.so
