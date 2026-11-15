#!/usr/bin/env bats

# bin/optimia is now a thin Node launcher (see Fase 10), not a bash script —
# these tests exercise it as a black box: CLI flags and the .optimia/
# project-dir setup it performs before handing off to the server.

OPTIMIA_BIN="${BATS_TEST_DIRNAME}/../bin/optimia"

setup() {
    # optimia's global state (workbenches, timeline) in a temporary folder, never in the real HOME.
    export XDG_CONFIG_HOME=$(mktemp -d)
    export XDG_DATA_HOME=$(mktemp -d)
    export OPTIMIA_NO_UPDATE_CHECK=1
    TESTDIR=$(mktemp -d)
}

teardown() {
    rm -rf "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
    rm -rf "$TESTDIR"
}

@test "optimia --version: prints a version string matching package.json" {
    run node "$OPTIMIA_BIN" --version
    [ "$status" -eq 0 ]
    expected=$(node -e "console.log(require('${BATS_TEST_DIRNAME}/../package.json').version)")
    [[ "$output" == "optimia $expected" ]]
}

@test "optimia --help: documents that config lives in the web UI, not the CLI" {
    run node "$OPTIMIA_BIN" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"interfaz web"* ]]
}

@test "optimia: in a git repo, creates .optimia/ and leaves the repo clean (no .gitignore edits)" {
    cd "$TESTDIR"
    git init -q
    git config user.email test@test.com
    git config user.name test
    echo hola > README.md
    git add README.md
    git commit -q -m init

    # stdin redirected from /dev/null -> not a TTY -> codegraph prompt
    # auto-declines instead of hanging; server keeps running until killed.
    OPTIMIA_NO_OPEN=1 node "$OPTIMIA_BIN" < /dev/null > server.log 2>&1 &
    pid=$!
    for i in $(seq 1 50); do
        grep -q "optimia running at" server.log 2>/dev/null && break
        sleep 0.1
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    [ -d .optimia ]
    [ ! -e .codegraph ]
    [ ! -e .gitignore ]
    [ ! -e .claude ]
    grep -q '^/.optimia$' .git/info/exclude
    [ -z "$(git status --porcelain -- . ':!server.log')" ]
    grep -q "optimia running at" server.log
}

@test "optimia --port: listens on the given port, and rejects bad values" {
    cd "$TESTDIR"
    port=$((40000 + RANDOM % 20000))
    OPTIMIA_NO_OPEN=1 node "$OPTIMIA_BIN" --port "$port" < /dev/null > server.log 2>&1 &
    pid=$!
    for i in $(seq 1 50); do
        grep -q "optimia running at" server.log 2>/dev/null && break
        sleep 0.1
    done
    grep -q "http://127.0.0.1:$port/" server.log
    run node "$OPTIMIA_BIN" --port "$port"
    [ "$status" -ne 0 ]
    [[ "$output" == *"está ocupado"* ]]
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    run node "$OPTIMIA_BIN" --port abc
    [ "$status" -ne 0 ]
    [[ "$output" == *"puerto no válido"* ]]
}

@test "optimia: outside a git repo, still creates .optimia/ but skips CodeGraph setup" {
    cd "$TESTDIR"

    OPTIMIA_NO_OPEN=1 node "$OPTIMIA_BIN" < /dev/null > server.log 2>&1 &
    pid=$!
    for i in $(seq 1 50); do
        [ -d .optimia ] && break
        sleep 0.1
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    [ -d .optimia ]
    [ ! -e .codegraph ]
}
