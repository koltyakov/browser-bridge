# Repository task runner. npm lifecycle hooks stay independent of Make so the
# published bootstrap package can install on machines without development tools.
.DEFAULT_GOAL := help
.DELETE_ON_ERROR:
.SILENT:

# Tests and packaging share dist/. Preserve prerequisite
# order even with make -j, especially tests -> native builds -> npm packaging.
.NOTPARALLEL:

NODE ?= node
NPM ?= npm
GO ?= go
GO_COVER_PROFILE = dist/coverage/go-unit.out
GOLANGCI_LINT_VERSION ?= v2.14.0
INSTALL_DIR ?=
TARGET ?=
TARBALL ?= ./browserbridge-bbx-$(shell "$(NODE)" scripts/version.mjs --print).tgz
ARGS ?=
TEST_ARGS ?=
TEST_FILES ?= packages/*/test/*.test.ts protocol/test/*.test.ts tests/integration/*.test.ts tests/fixtures/*/*.test.ts tests/native/*.test.ts
EXEC = $(NPM) exec --no --
DEVELOPMENT_LDFLAGS = -X github.com/koltyakov/browser-bridge/internal/bridge.developmentHash=$(shell "$(NODE)" scripts/native-build-hash.mjs)
# npm exec sets npm_command=exec, which changes the installer behavior exercised
# by subprocess tests. Invoke c8 directly to preserve the caller's environment.
C8 = "$(NODE)" node_modules/c8/bin/c8.js
ifeq ($(OS),Windows_NT)
EXE = .exe
endif

.PHONY: help deps clean build build-extension build-native lint lint-js lint-go typecheck format format-js \
	format-go check-go-format format-check test test-js test-runtime test-go test-native \
	vet-go coverage coverage-review coverage-check coverage-go coverage-go-check generate-protocol check-protocol \
	check-release-version check check-extension-zip package-extension package-native \
	package-native-all package-npm pack pack-dry-run release-check prepublish-check \
	publish-native publish-npm fixture-browser fixture-interaction bench-interaction \
	run status daemon install-manifest install sync-version bench-runtime

help: ## Show available tasks; the default when running make
	@"$(NODE)" -e "const fs = require('node:fs'); for (const m of fs.readFileSync('Makefile', 'utf8').matchAll(/^([a-z][a-z-]+):.*?## (.+)$$/gm)) console.log(m[1].padEnd(24) + m[2]);"

deps: sync-version ## Install the locked npm development dependencies
	$(NPM) ci

clean: ## Remove build output, coverage, and generated npm hashes
	"$(NODE)" -e "const fs = require('node:fs'); for (const file of ['dist', 'coverage', 'bbx', 'bbx.exe', 'packages/npm/native-manifest.json']) fs.rmSync(file, {recursive: true, force: true});"

build: build-extension build-native ## Build the unpacked extension and local Go executable

build-extension: sync-version ## Compile the unpacked extension with source maps
	"$(NODE)" scripts/package-extension.mjs --build-only

build-native: export CGO_ENABLED = 0
build-native: generate-protocol ## Build the local Go executable with current version metadata
	$(GO) build -trimpath -tags=nethttpomithttp2 -gcflags=all=-l -ldflags="-s -w $(DEVELOPMENT_LDFLAGS)" -o dist/cli/bbx$(EXE) ./cmd/bbx

install: generate-protocol build ## Build and install to ~/.local/bin, refresh native registration, and restart runtime
	./dist/cli/bbx$(EXE) install-self $(if $(INSTALL_DIR),--bin-dir "$(INSTALL_DIR)",) $(ARGS)

lint: lint-js lint-go ## Check JavaScript/TypeScript and Go lint and formatting

lint-js: ## Check JavaScript/TypeScript lint and formatting
	$(EXEC) oxlint .
	$(EXEC) oxfmt --check .

lint-go: check-go-format ## Check Go formatting and run pinned golangci-lint
	$(GO) run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION) run --timeout=5m

typecheck: ## Check TypeScript and typed JavaScript
	$(EXEC) tsc --noEmit

format: format-js format-go ## Format JavaScript, TypeScript, and Go

format-js: ## Format JavaScript, TypeScript, and project configuration
	$(EXEC) oxfmt .

format-go: ## Format Go source
	gofmt -w cmd internal

check-go-format: ## Check Go formatting without changing files
	"$(NODE)" scripts/check-go-format.mjs

format-check: check-go-format ## Check all source formatting
	$(EXEC) oxfmt --check .

test: test-go test-js ## Run Go race tests and the Node suite with coverage

test-js: build-extension build-native ## Run Node tests with coverage; override TEST_FILES or TEST_ARGS
	$(C8) "$(NODE)" --import tsx --test $(TEST_ARGS) $(TEST_FILES)

test-runtime: build-extension build-native ## Run the Node suite without coverage
	"$(NODE)" --import tsx --test $(TEST_ARGS) $(TEST_FILES)

test-go: ## Run Go race tests and collect unit-test coverage
	"$(NODE)" -e "require('node:fs').mkdirSync('dist/coverage', {recursive: true})"
	$(GO) test -race -coverprofile=$(GO_COVER_PROFILE) ./...

coverage-go: ## Report Go unit-test statement coverage from the last test-go run
	$(GO) tool cover -func=$(GO_COVER_PROFILE)

coverage-go-check: ## Enforce separate Go runtime and protocol unit-coverage baselines
	"$(NODE)" scripts/check-go-coverage.mjs $(GO_COVER_PROFILE)

test-native: test-go build-native ## Run Go race tests and native cross-language integration tests
	"$(NODE)" --import tsx --test $(TEST_ARGS) tests/native/*.test.ts tests/integration/*.test.ts

vet-go: ## Run Go static analysis
	$(GO) vet ./...

coverage: ## Report coverage from the last test-js run
	$(C8) report --reporter=text --reporter=text-summary

coverage-review: ## List the lowest-covered files
	$(C8) report --reporter=json-summary
	"$(NODE)" scripts/review-coverage.mjs

coverage-check: ## Enforce the existing line and branch coverage thresholds
	$(C8) check-coverage --lines 92 --branches 83

sync-version: ## Mirror manifest.json locally or the pipeline Git tag into package metadata
	"$(NODE)" scripts/version.mjs --sync

generate-protocol: sync-version ## Generate shared protocol types, schemas, catalog, and skills
	"$(NODE)" scripts/generate-protocol.mjs

check-protocol: ## Check that generated protocol files are current
	"$(NODE)" scripts/generate-protocol.mjs --check

check-release-version: ## Check release version consistency
	"$(NODE)" scripts/check-release-version.mjs

check: sync-version check-release-version check-protocol lint typecheck vet-go test coverage-check coverage-go-check ## Run all source validation and tests

package-extension: sync-version ## Build the release extension directory and ZIP without source maps
	"$(NODE)" scripts/package-extension.mjs

check-extension-zip: ## Validate the existing extension ZIP
	"$(NODE)" scripts/check-extension-zip.mjs

package-native: generate-protocol ## Build a size-checked native release binary; optional TARGET=linux-amd64
	"$(NODE)" scripts/build-native.mjs $(TARGET)

package-native-all: generate-protocol ## Build all five size-checked native release targets
	"$(NODE)" scripts/build-native.mjs --all

pack: sync-version ## Pack npm using existing native assets; prepack generates pinned hashes
	$(NPM) pack

pack-dry-run: sync-version ## Validate npm contents using existing native assets
	$(NPM) pack --dry-run

package-npm: package-native-all pack ## Build all native assets and create the npm tarball

release-check: check package-extension check-extension-zip package-native-all pack-dry-run ## Validate and build release artifacts without publishing

prepublish-check: check package-native-all ## Validate source and prepare all native assets for npm publication

publish-native: ## Publish and verify existing immutable native assets on GitHub
	"$(NODE)" scripts/publish-native.mjs

publish-npm: ## Publish the current-version tarball; optional TARBALL or ARGS
	$(NPM) publish "$(TARBALL)" --access public $(ARGS)

fixture-browser: ## Start the browser reliability fixture; optional ARGS='--port 4317'
	"$(NODE)" tests/fixtures/browser-reliability/server.mjs $(ARGS)

fixture-interaction: ## Start the agent interaction fixture
	"$(NODE)" tests/fixtures/agent-interaction/server.mjs $(ARGS)

bench-interaction: build-native ## Run the interaction benchmark
	"$(NODE)" tests/fixtures/agent-interaction/bench.mjs $(ARGS)

bench-runtime: ## Benchmark daemon routing while storage is blocked; optional ARGS='-benchtime=2s'
	$(GO) test -run '^$$' -bench BenchmarkDaemonHealthWhileStorageBlocked -benchmem $(ARGS) ./internal/bridge

run: generate-protocol ## Run the workspace Go CLI; e.g. make run ARGS='call health.ping'
	$(GO) run -ldflags="$(DEVELOPMENT_LDFLAGS)" ./cmd/bbx $(ARGS)

status: generate-protocol ## Check bridge status using the workspace Go CLI
	$(GO) run -ldflags="$(DEVELOPMENT_LDFLAGS)" ./cmd/bbx status

daemon: generate-protocol ## Start the daemon using the workspace Go CLI
	$(GO) run -ldflags="$(DEVELOPMENT_LDFLAGS)" ./cmd/bbx --bridge-daemon

install-manifest: build-native ## Register the built workspace native host; optional ARGS='<extension-id>'
	./dist/cli/bbx$(EXE) install $(ARGS)
