TAGS := sqlite_fts5

.PHONY: build test bench vet smoke mutate

build:
	go build -tags $(TAGS) -o ziwo ./cmd/ziwo

test:
	go test -tags $(TAGS) -race ./...

bench:
	go test -tags $(TAGS) -run '^$$' -bench . ./internal/vector

vet:
	go vet -tags $(TAGS) ./...

# End to end: runs the real binary, serves memories and talks MCP to them
# over HTTP. Listens on 127.0.0.1:18391 and 18392.
smoke: build
	python3 scripts/smoke_bodies.py "$(CURDIR)/ziwo" '' "$${TMPDIR:-/tmp}/ziwo-smoke" "$(CURDIR)/scripts/fake_embed.py"

# Changes one line of code at a time and expects the tests to notice. It
# edits the source in place and puts it back, so run it on a clean tree.
mutate:
	python3 scripts/mutate.py
