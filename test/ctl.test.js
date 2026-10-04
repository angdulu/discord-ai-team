const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-test-'));
  const workspace = path.join(directory, 'Documents', 'bot workspace');
  const commands = path.join(directory, 'bin');
  const home = path.join(directory, 'home');
  fs.mkdirSync(path.join(workspace, 'bots'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'logs'));
  fs.mkdirSync(commands);
  fs.mkdirSync(home);
  fs.copyFileSync(path.join(__dirname, '..', 'ctl.sh'), path.join(workspace, 'ctl.sh'));
  fs.writeFileSync(path.join(workspace, 'bots', 'chatgpt.env'), '');
  const scripts = {
    uname: 'echo Darwin',
    pgrep: 'exit 1',
    sleep: 'exit 0',
    launchctl: `
case "$1" in
  remove) rm -f "$TEST_DIRECTORY/running" ;;
  list)
    if [ -f "$TEST_DIRECTORY/running" ]; then
      echo '12345 0 com.discord-ai-team.chatgpt'
    elif [ "$2" = com.discord-ai-team.chatgpt ]; then
      echo '"LastExitStatus" = 19968;'
    fi ;;
  submit)
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o) output="$2"; shift 2 ;;
        -e) error="$2"; shift 2 ;;
        --) break ;;
        *) shift ;;
      esac
    done
    printf '%s\\n%s\\n' "$output" "$error" > "$TEST_DIRECTORY/paths"
    if [ "$TEST_FAIL" != true ]; then
      echo '[ChatGPT] logged in as test' > "$output"
      touch "$TEST_DIRECTORY/running"
    fi ;;
esac`,
  };
  for (const [name, script] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(commands, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  return { directory, workspace, home, run(fail = false) {
    return spawnSync('zsh', [path.join(workspace, 'ctl.sh'), 'start', 'chatgpt'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${commands}:${process.env.PATH}`,
        TEST_DIRECTORY: directory, TEST_FAIL: String(fail) },
    });
  } };
}

test('macOS launches with Library logs and preserves local log links and previous content', () => {
  const fixture = setup();
  try {
    const log = path.join(fixture.workspace, 'logs', 'chatgpt.log');
    fs.writeFileSync(log, 'previous log');
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /chatgpt started/);
    const paths = fs.readFileSync(path.join(fixture.directory, 'paths'), 'utf8').trim().split('\n');
    for (const target of paths) {
      assert.ok(target.startsWith(path.join(fixture.home, 'Library', 'Logs', 'discord-ai-team') + path.sep));
      assert.equal(fs.readlinkSync(path.join(fixture.workspace, 'logs', path.basename(target))), target);
    }
    assert.equal(fs.readFileSync(log, 'utf8'), '[ChatGPT] logged in as test\n');
    assert.equal(fs.readFileSync(`${log}.previous`, 'utf8'), 'previous log');
    fs.rmSync(path.join(fixture.directory, 'running'));
    assert.equal(fixture.run().status, 0);
    assert.equal(fs.readFileSync(`${log}.previous`, 'utf8'), 'previous log');
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('macOS startup failure reports launchd status even when application logs are empty', () => {
  const fixture = setup();
  try {
    const result = fixture.run(true);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /chatgpt failed to start/);
    assert.match(result.stdout, /launchd:.*LastExitStatus.*19968/);
    assert.match(result.stdout, /Logs:.*Library\/Logs\/discord-ai-team/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
