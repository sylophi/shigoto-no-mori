#!/usr/bin/env bash
# Seeds a scratch state root for `sm doctor` to diagnose and prints its
# path. `healthy` seeds two well-formed projects; `broken` (the default)
# seeds every fault the command knows how to report. Nothing outside the
# temp directory is touched.
set -euo pipefail

mode="${1:-broken}"
# Resolved with `pwd -P`: both /tmp and the macOS default TMPDIR live
# behind symlinks, and registering a project through one trips the
# "registered through a symlinked path" check on every project, burying
# the faults this fixture is actually about.
root="$(cd "$(mktemp -d "/tmp/sm-doctor-scratch.XXXXXX")" && pwd -P)"
mkdir -p "$root/repos" "$root/worktrees" "$root/updates" "$root/projects"

newrepo() {
  local path="$1"
  mkdir -p "$path"
  git -C "$path" init --quiet -b main
  git -C "$path" -c user.email=seed@example.com -c user.name=Seed \
    commit --quiet --allow-empty -m "init"
}

if [ "$mode" = healthy ]; then
  newrepo "$root/repos/alpha"
  newrepo "$root/repos/beta"
  cat > "$root/registry.json" <<JSON
{"projects":[
  {"id":"AAAA1111","name":"alpha","path":"$root/repos/alpha"},
  {"id":"BBBB2222","name":"beta","path":"$root/repos/beta"}
]}
JSON
  mkdir -p "$root/projects/AAAA1111" "$root/projects/BBBB2222"
  echo '{"defaultBranch":"main"}' > "$root/projects/AAAA1111/project.json"
  echo '{"defaultBranch":"main"}' > "$root/projects/BBBB2222/project.json"
  echo '{"portPool":false}' > "$root/config.json"
  echo "$root"
  exit 0
fi

# alpha: healthy repo, but its layout and config are a mess.
newrepo "$root/repos/alpha"
mkdir -p "$root/worktrees/alpha"
git -C "$root/repos/alpha" worktree add --quiet -b feature/vanished \
  "$root/worktrees/alpha/vanished" >/dev/null
rm -rf "$root/worktrees/alpha/vanished"          # gone from disk, still in git's metadata
mkdir -p "$root/worktrees/alpha/stray-leftover"  # in the layout, unknown to git

# beta: repo is fine, project.json is not.
newrepo "$root/repos/beta"

# ghost: registered, directory gone. not-a-repo: a plain directory.
mkdir -p "$root/repos/not-a-repo"

id_alpha=AAAA1111; id_beta=BBBB2222; id_ghost=CCCC3333; id_plain=DDDD4444
cat > "$root/registry.json" <<JSON
{"projects":[
  {"id":"$id_alpha","name":"alpha","path":"$root/repos/alpha"},
  {"id":"$id_beta","name":"beta","path":"$root/repos/beta"},
  {"id":"$id_ghost","name":"ghost","path":"$root/repos/ghost-gone"},
  {"id":"$id_plain","name":"not-a-repo","path":"$root/repos/not-a-repo"}
]}
JSON

mkdir -p "$root/projects/$id_alpha" "$root/projects/$id_beta" "$root/projects/$id_ghost" "$root/projects/$id_plain"
# alpha's setup script names a file that isn't in the repo.
echo '{"defaultBranch":"main","scripts":{"setup":"bash scripts/bootstrap.sh"}}' > "$root/projects/$id_alpha/project.json"
# beta's project.json parses but has no defaultBranch.
echo '{"setupScript":"echo hi"}' > "$root/projects/$id_beta/project.json"
echo '{"defaultBranch":"main"}' > "$root/projects/$id_ghost/project.json"
echo '{"defaultBranch":"main"}' > "$root/projects/$id_plain/project.json"

printf '{"portPool": true,' > "$root/config.json"   # truncated: not valid JSON

# Two locks nobody is holding, and an update staging lock from a dead pid.
touch -t 202001010000 "$root/projects/$id_alpha/project.json.lock" "$root/registry.json.lock"
echo 999999 > "$root/updates/staging.pid"

echo "$root"
