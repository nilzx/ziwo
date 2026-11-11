TAGS := sqlite_fts5

.PHONY: build test bench vet

build:
	go build -tags $(TAGS) -o ziwo ./cmd/ziwo

test:
	go test -tags $(TAGS) -race ./...

bench:
	go test -tags $(TAGS) -run '^$$' -bench . ./internal/vector

vet:
	go vet -tags $(TAGS) ./...
