#!/bin/bash
# Real-process engineering checks for counterpart-host. NOT UI acceptance.
#
# Runs every command as a disposable fixture account with a real password-database home,
# a lingering systemd user manager and its own session bus, so the keyed worker's empty
# environment, the user service and Secret Service are the real ones. Never point it at a
# person's account: it creates and deletes Counterpart state and keyring items there.
#
#   sudo useradd -m -s /bin/bash stm-hosttest && sudo loginctl enable-linger stm-hosttest
#   tools/linux-host/tests/real-host.sh RESOURCES_DIR [ACCOUNT]
#
# Needs: sudo -n, gnome-keyring, libsecret-tools (secret-tool). Prints PASS/FAIL lines.
set -uo pipefail
resources=${1:?resources directory from prepare-payload.sh}
account=${2:-stm-hosttest}
uid=$(id -u "$account") || exit 1
home=$(getent passwd "$account" | cut -d: -f6)
[ "$home" != "$HOME" ] || { echo "Refusing to run against your own account" >&2; exit 1; }
state="$home/.local/share/counterpart"
installed="$home/resources"   # outside /usr and /opt: setup must copy it (as for an AppImage)
port=19177
failures=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; failures=$((failures+1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
# A plain sudo shell: no XDG_RUNTIME_DIR or DBUS_SESSION_BUS_ADDRESS, as for a worker the companion starts.
as() { sudo -n -u "$account" -H env -i HOME="$home" PATH=/usr/bin:/bin "$@"; }
session() { as XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"; }
helper="$installed/host/counterpart-host"
json() { python3 -c "import json,sys; v=json.load(sys.stdin); print($1)"; }

echo "== reset the fixture account (earlier runs are moved aside, not deleted)"
session systemctl --user disable --now counterpart-companion.service >/dev/null 2>&1
session pkill -u "$account" -f gnome-keyring-daemon
aside="$home/previous-runs/$(date +%s)"
as mkdir -p "$aside"
for path in "$state" "$home/.config/systemd/user/counterpart-companion.service" "$home/.local/share/keyrings" "$home/fake" \
  "$home/.local/bin/codex" "$home/.local/share/dbus-1/services/org.freedesktop.secrets.service" "$installed"; do
  if sudo -n test -e "$path"; then as mv "$path" "$aside/$(echo "$path" | tr / _)"; fi
done
session systemctl --user daemon-reload

echo "== install as a non-system copy"
sudo -n cp -a "$resources" "$installed"
sudo -n chown -R "$account:$account" "$installed"
session systemctl --user mask gnome-keyring-daemon.service gnome-keyring-daemon.socket >/dev/null 2>&1

echo "== status before setup"
out=$(as "$helper" status)
check "status reports unconfigured" test "$(echo "$out" | json 'v["configured"], v["running"]')" = "False False"
check "control socket is the private runtime directory" test "$(echo "$out" | json 'v["controlSocket"]')" = "/run/user/$uid/counterpart/control.sock"

echo "== setup (seeded port, from a shell without session variables)"
as sh -c "umask 077; mkdir -p '$state' && printf 'SCAN_TO_MAKE_GENERATION_PORT=$port\nMCP_TRANSPORT=stdio\n' > '$state/companion.env'"
out=$(as "$helper" setup) || fail "setup exit: $out"
check "setup configured and running" test "$(echo "$out" | json 'v["configured"], v["running"]')" = "True True"
check "runtime copied and selected" sudo -n test -x "$state/runtime/current/host/counterpart-host"
check "unit runs the stable runtime link" sudo -n grep -q "ExecStart=\"$state/runtime/current/host/counterpart-host\" serve" "$home/.config/systemd/user/counterpart-companion.service"
command=$(as cat "$state/printer-handoff.json" | json 'v["process"]["command"]')
check "printer config names the runtime's absolute node" test "$command" = "$state/runtime/current/Payload/node/bin/node"
check "handoff paths appended to the seeded companion.env" as grep -q SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG "$state/companion.env"
check "seeded port kept" as grep -q "SCAN_TO_MAKE_GENERATION_PORT=$port" "$state/companion.env"
check "state is private" test "$(sudo -n stat -c %a "$state")" = 700
pid=$(session systemctl --user show -p MainPID --value counterpart-companion.service)
identity() { sudo -n python3 -c "import json,sys; c=json.load(open(sys.argv[1]))[\"configuration\"]; print(c[\"host\"], c[\"certificateSha256\"])" "$state/auth/auth.json"; }
auth_identity=$(identity)

control() {  # control METHOD [PARAMS_JSON]
  as "$state/runtime/current/Payload/node/bin/node" -e '
    const s=require("net").connect(process.argv[1]);let r="";
    s.on("data",d=>r+=d).on("end",()=>{process.stdout.write(r)}).on("connect",()=>s.end(JSON.stringify({v:1,id:require("crypto").randomUUID(),method:process.argv[2],params:JSON.parse(process.argv[3])})+"\n"));
    s.setTimeout(20000,()=>{s.destroy();process.exit(1)});' "/run/user/$uid/counterpart/control.sock" "$1" "${2:-{\}}"
}
echo "== companion over the control socket"
status=$(control status.get)
check "status.get platform linux, no CloudKit enrolment" test "$(echo "$status" | json 'v["result"]["platform"], v["result"]["capabilities"]["icloudEnrolment"], v["result"]["capabilities"]["objectsCreate"]')" = "linux False True"
printers=$(control objects.printers)
# Known gap, reported to the integration owner: the default config is listed as an unconfigured "current" printer.
echo "INFO printers before Download: $(echo "$printers" | json '[(d["id"], d["name"], d.get("state")) for d in v["result"]["destinations"]]')"
mcps=$(control printers.mcps)
check "printer MCPs offered for Download, none installed" test "$(echo "$mcps" | json '[p["installed"] for p in v["result"]["packages"]]')" = "[False, False]"
starter=$(control objects.addStarter '{"starterId":"scan-platform"}')
check "a starter project can be created" test "$(echo "$starter" | json '"ok" if "result" in v else v')" = "ok"
check "companion error log has no startup failure" bash -c "! sudo -n grep -q -E 'ZodError|Error:' '$state/logs/companion-error.log'"

echo "== setup again is idempotent"
out=$(as "$helper" setup) || fail "second setup: $out"
check "service not restarted" test "$(session systemctl --user show -p MainPID --value counterpart-companion.service)" = "$pid"
check "pairing identity (address and certificate pin) kept" test "$(identity)" = "$auth_identity"

echo "== service stop/start"
check "stop" test "$(as "$helper" service stop | json 'v["running"]')" = False
check "start" test "$(as "$helper" service start | json 'v["running"]')" = True

echo "== credentials and keyed worker"
fake="$home/fake"; as mkdir -p "$fake" "$home/.local/bin"
as tee "$home/.local/bin/codex" >/dev/null <<'EOF'
#!/bin/bash
fake=$(dirname "$(dirname "$(dirname "$0")")")/fake
case "$1" in --version) echo "codex-cli 0.99.0"; exit 0;; esac
{ echo "key=$(printf %s "$SCAN_TO_MAKE_AI_KEY" | sha256sum | cut -c1-16)"; echo "model_key_env=${SCAN_TO_MAKE_MODEL_KEY:+present}"; grep base_url "$CODEX_HOME/config.toml"; } > "$fake/seen"
if [ "$(cat "$fake/mode" 2>/dev/null)" = hang ]; then setsid sleep 900 & echo $! > "$fake/descendant"; echo $$ > "$fake/cli"; sleep 900; fi
while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo OK > "$2"; }; shift; done
echo '{"type":"turn.completed"}'
EOF
as chmod 755 "$home/.local/bin/codex"
session sh -c 'printf testpw | gnome-keyring-daemon --replace --unlock --components=secrets -d >/dev/null'
sleep 1
endpoint='{"kind":"endpoint","url":"https://models.example.test/v1","model":"fixture-model"}'
stored=$(printf '{"choice":%s,"secret":"fixture-key-123"}' "$endpoint" | session "$helper" credentials store) || fail "store: $stored"
choice=$(echo "$stored" | json 'json.dumps(v["choice"])')
check "store returns a bound reference and never the key" bash -c "echo '$stored' | grep -q keychainRef && ! echo '$stored' | grep -q fixture-key"
check "one item in Counterpart's namespace" test "$(session secret-tool search --all application com.scantomake.model-access 2>&1 | grep -c '^attribute.reference')" = 1
worker() { as env -i "$state/runtime/current/host/counterpart-host" --model-worker "$@"; }  # empty environment, as the companion passes
rm_seen() { as rm -f "$fake/seen"; }
rm_seen; out=$(echo "$choice" | worker check)
check "keyed check connects through the CLI" test "$(echo "$out" | json 'v["ok"]')" = True
check "the worker saw exactly the saved key and endpoint" bash -c "sudo -n cat '$fake/seen' | grep -q 'key=$(printf %s fixture-key-123 | sha256sum | cut -c1-16)' && sudo -n grep -q 'models.example.test/v1' '$fake/seen'"
other=$(echo "$choice" | sed 's#models.example.test#evil.example.test#')
rm_seen; out=$(echo "$other" | worker check)
check "a key saved for one endpoint is refused for another" test "$(echo "$out" | json 'v["outcome"]')" = auth-failed
check "the refused request never ran the CLI" sudo -n test ! -e "$fake/seen"
out=$(echo "$choice" | as env -i SCAN_TO_MAKE_CAPTURE_PYTHON=/tmp/x "$state/runtime/current/host/counterpart-host" --model-worker check)
check "caller environment is refused for a keyed request" test "$(echo "$out" | json 'v["ok"]')" = False

echo "== cancellation reaches the CLI and its detached descendants"
echo hang | as tee "$fake/mode" >/dev/null
cancelled=$(as "$state/runtime/current/Payload/node/bin/node" --input-type=module -e "
  const {createModelWorker}=await import('$state/runtime/current/Payload/source/services/companion/dist/model-access-worker.js');
  const c=new AbortController();setTimeout(()=>c.abort(),8000);
  try{await createModelWorker('$state/runtime/current/host/counterpart-host')(JSON.parse(process.argv[1]),['check'],{signal:c.signal});console.log('finished');}
  catch(e){console.log(c.signal.aborted?'aborted':'error '+e.message);}" "$choice" 2>&1)
check "worker aborted" test "$cancelled" = aborted
sleep 4
for name in cli descendant; do
  p=$(sudo -n cat "$fake/$name" 2>/dev/null)
  check "$name process gone after cancel" bash -c "[ -n '$p' ] && ! kill -0 '$p' 2>/dev/null && ! sudo -n kill -0 '$p' 2>/dev/null"
done
as rm -f "$fake/mode"

echo "== keyring locked, then no Secret Service"
session busctl --user call org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service Lock ao 1 /org/freedesktop/secrets/collection/login >/dev/null
out=$(echo "$choice" | worker check)
check "locked keyring reports needs-gui-session" test "$(echo "$out" | json 'v["outcome"]')" = needs-gui-session
# No provider at all: a user-level D-Bus service file overrides the system activation file for this account only.
as mkdir -p "$home/.local/share/dbus-1/services"
printf '[D-BUS Service]\nName=org.freedesktop.secrets\nExec=/bin/false\n' | as tee "$home/.local/share/dbus-1/services/org.freedesktop.secrets.service" >/dev/null
session busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null
session pkill -u "$account" -f gnome-keyring-daemon; sleep 1
out=$(echo "$choice" | worker check)
check "no Secret Service reports a failure, not a crash" test "$(echo "$out" | json 'v["outcome"]')" = failed
err=$(printf '{"choice":%s,"secret":"k2"}' "$endpoint" | session "$helper" credentials store 2>&1 >/dev/null)
check "store without Secret Service is actionable and redacted" bash -c "echo \"$err\" | grep -q 'Secret Service' && ! echo \"$err\" | grep -q k2"
as rm -f "$home/.local/share/dbus-1/services/org.freedesktop.secrets.service"
session busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null
session sh -c 'printf testpw | gnome-keyring-daemon --replace --unlock --components=secrets -d >/dev/null'; sleep 1
ref=$(echo "$choice" | json 'v["keychainRef"]')
check "remove deletes only that reference" test "$(printf '{"reference":"%s"}' "$ref" | session "$helper" credentials remove | json 'v["removed"]')" = True
out=$(echo "$choice" | worker check)
check "a removed key reports auth-failed" test "$(echo "$out" | json 'v["outcome"]')" = auth-failed

echo "== private diagnostics"
check "setup log, if any, is private" bash -c "[ ! -e '$state/logs/setup.log' ] || [ \$(sudo -n stat -c %a '$state/logs/setup.log') = 600 ]"
check "no key in any log" bash -c "! sudo -n grep -r -q fixture-key-123 '$state/logs' '$fake/seen'"

echo "== stop"
as "$helper" service stop >/dev/null
session pkill -u "$account" -f gnome-keyring-daemon
echo "failures=$failures"
exit $((failures > 0))
