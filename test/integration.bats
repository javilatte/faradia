#!/usr/bin/env bats

# End-to-end integration: run the real `bin/faradia` launcher against a fresh
# project and exercise its HTTP API for real (no mocked server).

FARADIA_BIN="${BATS_TEST_DIRNAME}/../bin/faradia"

setup() {
    export FARADIA_TOKEN=bats-token
    # faradia's global state (workbenches, timeline) in a temporary folder, never in the real HOME.
    export XDG_CONFIG_HOME=$(mktemp -d)
    export XDG_DATA_HOME=$(mktemp -d)
    export FARADIA_NO_UPDATE_CHECK=1
    TESTDIR=$(mktemp -d)
    cd "$TESTDIR"
    git init -q
    git config user.email test@test.com
    git config user.name test
    echo hola > README.md
    git add README.md
    git commit -q -m init

    FARADIA_TOKEN=bats-token FARADIA_NO_OPEN=1 node "$FARADIA_BIN" < /dev/null > server.log 2>&1 &
    SERVER_PID=$!
    PORT=""
    for i in $(seq 1 50); do
        PORT=$(grep -oE 'http://127\.0\.0\.1:[0-9]+' server.log | head -1 | grep -oE '[0-9]+$' || true)
        [ -n "$PORT" ] && break
        sleep 0.1
    done
}

teardown() {
    rm -rf "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    rm -rf "$TESTDIR"
}

@test "GET /api/health: reports ok and the project root" {
    [ -n "$PORT" ]
    run node -e "fetch('http://127.0.0.1:$PORT/api/health',{headers:{'X-Faradia-Token':'bats-token'}}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d)))"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"ok":true'* ]]
    [[ "$output" == *"$TESTDIR"* ]]
}

@test "GET /: serves the real web UI (index.html)" {
    [ -n "$PORT" ]
    run node -e "fetch('http://127.0.0.1:$PORT/').then(r=>r.text()).then(t=>console.log(t.includes('<title>Faradia</title>')))"
    [ "$status" -eq 0 ]
    [[ "$output" == "true" ]]
}

@test "GET /api/settings: returns default settings for a project with no settings.json yet" {
    [ -n "$PORT" ]
    run node -e "fetch('http://127.0.0.1:$PORT/api/settings',{headers:{'X-Faradia-Token':'bats-token'}}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d)))"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"mode":"claude"'* ]]
}

@test "GET /api/tasks: returns an empty list for a fresh project" {
    [ -n "$PORT" ]
    run node -e "fetch('http://127.0.0.1:$PORT/api/tasks',{headers:{'X-Faradia-Token':'bats-token'}}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d)))"
    [ "$status" -eq 0 ]
    [[ "$output" == "[]" ]]
}

@test "GET /api/local-models: returns a real array (Ollama's own models, or empty if not installed)" {
    [ -n "$PORT" ]
    run node -e "fetch('http://127.0.0.1:$PORT/api/local-models',{headers:{'X-Faradia-Token':'bats-token'}}).then(r=>r.json()).then(d=>console.log(JSON.stringify(Array.isArray(d))))"
    [ "$status" -eq 0 ]
    [[ "$output" == "true" ]]
}

@test "API without a token: answers 401" {
    [ -n "$PORT" ]
    run node -e "fetch('http://127.0.0.1:$PORT/api/settings').then(r=>console.log(r.status))"
    [ "$status" -eq 0 ]
    [[ "$output" == "401" ]]
}

@test "API with a foreign Host (DNS rebinding): answers 421" {
    [ -n "$PORT" ]
    run curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:1234' -H "X-Faradia-Token: $FARADIA_TOKEN" "http://127.0.0.1:$PORT/api/settings"
    [ "$status" -eq 0 ]
    [[ "$output" == "421" ]]
}
