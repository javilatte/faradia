#!/usr/bin/env bats

# bin/faradia is now a thin Node launcher (see Fase 10), not a bash script —
# these tests exercise it as a black box: CLI flags and the .faradia/
# project-dir setup it performs before handing off to the server.

FARADIA_BIN="${BATS_TEST_DIRNAME}/../bin/faradia"

setup() {
    # faradia's global state (workbenches, timeline) in a temporary folder, never in the real HOME.
    export XDG_CONFIG_HOME=$(mktemp -d)
    export XDG_DATA_HOME=$(mktemp -d)
    export FARADIA_NO_UPDATE_CHECK=1
    TESTDIR=$(mktemp -d)
}

teardown() {
    rm -rf "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
    rm -rf "$TESTDIR"
}

@test "faradia --version: prints a version string matching package.json" {
    run node "$FARADIA_BIN" --version
    [ "$status" -eq 0 ]
    expected=$(node -e "console.log(require('${BATS_TEST_DIRNAME}/../package.json').version)")
    [[ "$output" == "faradia $expected" ]]
}

@test "faradia --help: documents that config lives in the web UI, not the CLI" {
    run node "$FARADIA_BIN" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"interfaz web"* ]]
}

@test "faradia: in a git repo, creates .faradia/ and leaves the repo clean (no .gitignore edits)" {
    cd "$TESTDIR"
    git init -q
    git config user.email test@test.com
    git config user.name test
    echo hola > README.md
    git add README.md
    git commit -q -m init

    # stdin redirected from /dev/null -> not a TTY -> codegraph prompt
    # auto-declines instead of hanging; server keeps running until killed.
    FARADIA_NO_OPEN=1 node "$FARADIA_BIN" < /dev/null > server.log 2>&1 &
    pid=$!
    for i in $(seq 1 50); do
        grep -q "faradia running at" server.log 2>/dev/null && break
        sleep 0.1
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    [ -d .faradia ]
    [ ! -e .codegraph ]
    [ ! -e .gitignore ]
    [ ! -e .claude ]
    grep -q '^/.faradia$' .git/info/exclude
    [ -z "$(git status --porcelain -- . ':!server.log')" ]
    grep -q "faradia running at" server.log
}

@test "faradia --port: listens on the given port, and rejects bad values" {
    cd "$TESTDIR"
    port=$((40000 + RANDOM % 20000))
    FARADIA_NO_OPEN=1 node "$FARADIA_BIN" --port "$port" < /dev/null > server.log 2>&1 &
    pid=$!
    for i in $(seq 1 50); do
        grep -q "faradia running at" server.log 2>/dev/null && break
        sleep 0.1
    done
    grep -q "http://127.0.0.1:$port/" server.log
    run node "$FARADIA_BIN" --port "$port"
    [ "$status" -ne 0 ]
    [[ "$output" == *"está ocupado"* ]]
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    run node "$FARADIA_BIN" --port abc
    [ "$status" -ne 0 ]
    [[ "$output" == *"puerto no válido"* ]]
}

@test "faradia: outside a git repo, still creates .faradia/ but skips CodeGraph setup" {
    cd "$TESTDIR"

    FARADIA_NO_OPEN=1 node "$FARADIA_BIN" < /dev/null > server.log 2>&1 &
    pid=$!
    for i in $(seq 1 50); do
        [ -d .faradia ] && break
        sleep 0.1
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    [ -d .faradia ]
    [ ! -e .codegraph ]
}
