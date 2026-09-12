# Trusted function library for the release and state CLIs. Sourcing this file
# performs no work: no options, traps, positional arguments or globals change.
# Callers initialize the runtime coordinates explicitly; no data file is sourced.
hash_file() { local result; result=$(sha256sum -- "$1") || return 1; printf '%s' "${result%% *}"; }
file_mode() { stat -c '%a' -- "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
link_count() { stat -c '%h' -- "$1" 2>/dev/null || stat -f '%l' "$1"; }
regular() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(link_count "$1")" = 1 ]; }
safe_path() {
  local part cursor="" remaining=${1#/}
  [[ "$1" =~ ^/[A-Za-z0-9_./+-]+$ ]] && [ "$1" != / ] || return 1
  while [ -n "$remaining" ]; do
    part=${remaining%%/*}; [ -n "$part" ] && [ "$part" != . ] && [ "$part" != .. ] || return 1
    cursor=$cursor/$part; [ ! -L "$cursor" ] || return 1
    [ "$remaining" != "$part" ] || break; remaining=${remaining#*/}
  done
}
safe_directory() { local mode; safe_path "$1" && [ -d "$1" ] || return 1; mode=$(file_mode "$1") || return 1; (( (8#$mode & 0022) == 0 )); }
valid_release_id() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([A-Za-z0-9.+-]*)-[a-f0-9]{40}-[a-f0-9]{16}$ ]]; }
terminated_text() {
  # Validate bytes before Bash read: newer Bash versions silently discard NUL.
  [ "$(tr -d '\12\40-\176' < "$1" | wc -c | tr -d '[:space:]')" = 0 ] &&
    [ "$(tail -c 1 "$1" | od -An -tu1 | tr -d '[:space:]')" = 10 ]
}

read_bundle_env() {
  local line key value previous="" count=0 digest
  IMAGE_DESCRIPTOR_DIGEST=""; LOADED_IMAGE_DIGEST=""
  regular "$1" && terminated_text "$1" || return 1
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Z_0-9]+)=([A-Za-z0-9_./:+-]+)$ ]] || return 1
    key=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}
    [[ "$previous" < "$key" ]] || return 1; previous=$key; count=$((count+1))
    case "$key" in
      GATEWAY_GIT_COMMIT) COMMIT=$value ;;
      GATEWAY_GIT_COMMIT_TIMESTAMP) COMMIT_TIME=$value ;;
      GATEWAY_IMAGE_ARCHIVE) IMAGE_ARCHIVE=$value ;;
      GATEWAY_IMAGE_CONFIG_DIGEST) IMAGE_DIGEST=$value ;;
      GATEWAY_IMAGE_DESCRIPTOR_DIGEST) IMAGE_DESCRIPTOR_DIGEST=$value ;;
      GATEWAY_IMAGE_REPOSITORY) IMAGE_REPOSITORY=$value ;;
      GATEWAY_IMAGE_TAG) IMAGE_TAG=$value ;;
      GATEWAY_LOCK_SHA256) LOCK_SHA=$value ;;
      GATEWAY_RELEASE_ID) RELEASE_ID=$value ;;
      GATEWAY_RELEASE_PLATFORM) PLATFORM=$value ;;
      GATEWAY_RELEASE_POLICY_SHA256) BUNDLE_POLICY=$value ;;
      GATEWAY_RELEASE_SCHEMA) SCHEMA=$value ;;
      GATEWAY_RELEASE_TEST_MODE) TEST_MODE=$value ;;
      GATEWAY_VERSION) VERSION=$value ;;
      *) return 1 ;;
    esac
  done < "$1"
  # Exact legacy 13-key bundles remain rollback candidates. New 14-key bundles
  # additionally bind Docker/containerd's descriptor ID, never relabeling it as
  # a config digest. An unknown field or partial/malformed extension still fails.
  if [ "$count" = 14 ]; then [[ "$IMAGE_DESCRIPTOR_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  else [ "$count" = 13 ] && [ -z "$IMAGE_DESCRIPTOR_DIGEST" ] || return 1; fi
  [[ "$COMMIT" =~ ^[a-f0-9]{40}$ && "$LOCK_SHA" =~ ^[a-f0-9]{64}$ && "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || return 1
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$ ]] || return 1
  [[ "$COMMIT_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$ ]] || return 1
  [[ "$IMAGE_REPOSITORY" =~ ^[a-z0-9][a-z0-9._:/-]*$ && "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || return 1
  [ "$SCHEMA" = led-control-gateway-release/v1 ] && [ "$BUNDLE_POLICY" = "$POLICY_SHA" ] || return 1
  [ "$PLATFORM" = linux/arm64 ] && [ "$TEST_MODE" = 0 ] && [ "$IMAGE_ARCHIVE" = gateway-image-linux-arm64.tar ] || return 1
  digest=${IMAGE_DIGEST#sha256:}
  [ "$RELEASE_ID" = "$VERSION-$COMMIT-${digest:0:16}" ] && valid_release_id "$RELEASE_ID"
}
verify_bundle() {
  local directory=$1 entry relative count=0 line digest name previous=""
  safe_path "$directory" && [ -d "$directory" ] || return 1
  # NUL traversal rejects even extra names containing newlines; hardlinks and
  # unexpected directories/special files are forbidden, not silently skipped.
  while IFS= read -r -d '' entry; do
    relative=${entry#"$directory/"}
    case "$relative" in
      docker) [ -d "$entry" ] && [ ! -L "$entry" ] || return 1 ;;
      appliance.env|checksums.sha256|compose.yml|docker/seccomp-bluez-mesh.json|gateway-image-linux-arm64.tar|release-manifest.json|sbom.spdx.json)
        regular "$entry" && [ -s "$entry" ] || return 1; count=$((count+1)) ;;
      *) return 1 ;;
    esac
  done < <(find "$directory" -mindepth 1 -print0)
  [ "$count" = 7 ] && terminated_text "$directory/checksums.sha256" || return 1
  count=0
  while IFS= read -r line; do
    [[ "$line" =~ ^([a-f0-9]{64})\ \ ([A-Za-z0-9_./-]+)$ ]] || return 1
    digest=${BASH_REMATCH[1]}; name=${BASH_REMATCH[2]}
    [[ "$previous" < "$name" ]] || return 1; previous=$name
    case "$name" in appliance.env|compose.yml|docker/seccomp-bluez-mesh.json|gateway-image-linux-arm64.tar|release-manifest.json|sbom.spdx.json) ;; *) return 1 ;; esac
    [ "$(hash_file "$directory/$name")" = "$digest" ] || return 1; count=$((count+1))
  done < "$directory/checksums.sha256"
  [ "$count" = 6 ] && read_bundle_env "$directory/appliance.env"
}
# GNU sync -f uses syncfs on the containing filesystem. Never downgrade failed
# durability to an unflushed rename on hosts without this required primitive.
durable() { sync -f "$1"; }
pointer_id() {
  local target; POINTER=none
  if [ -L "$ROOT/$1" ]; then
    target=$(readlink "$ROOT/$1") || return 1; [[ "$target" = releases/* ]] || return 1
    POINTER=${target#releases/}; valid_release_id "$POINTER" && safe_directory "$ROOT/releases/$POINTER" || return 1
  elif [ -e "$ROOT/$1" ]; then return 1; fi
}
switch_pointer() {
  local name=$1 id=$2 temporary; pointer_id "$name" || return 1
  if [ "$id" = none ]; then
    if [ -L "$ROOT/$name" ]; then rm -- "$ROOT/$name" || return 1; fi
  else
    valid_release_id "$id" && safe_directory "$ROOT/releases/$id" || return 1
    temporary=$(mktemp "$ROOT/.pointer.XXXXXX") || return 1
    rm -- "$temporary" && ln -s "releases/$id" "$temporary" && mv -Tf -- "$temporary" "$ROOT/$name" || return 1
  fi
  durable "$ROOT"
}
atomic_copy() {
  local source=$1 destination=$2 mode=$3 temporary
  regular "$source" || return 1
  [ ! -e "$destination" ] && [ ! -L "$destination" ] || regular "$destination" || return 1
  temporary=$(mktemp "$ROOT/.env-write.XXXXXX") || return 1
  cp -- "$source" "$temporary" && chmod "$mode" "$temporary" && durable "$temporary" && mv -Tf -- "$temporary" "$destination" && durable "$ROOT"
}
site_dotenv() {
  local mode=$1 file=$2 default_data=/opt/led-control/data
  [ "$TEST_ROOT" != 1 ] || default_data=$ROOT/data
  regular "$file" && [ -s "$file" ] || return 1
  # Deliberately support single-line dotenv only. Reject multiline quotes, CR,
  # NUL and a missing final LF before writing anything; unrelated UTF-8 bytes
  # and literal shell expressions remain data. No source/eval/interpolation.
  [ "$(tr -cd '\000\015' < "$file" | wc -c | tr -d '[:space:]')" = 0 ] &&
    [ "$(tail -c 1 "$file" | od -An -tu1 | tr -d '[:space:]')" = 10 ] || return 1
  awk -v mode="$mode" -v repository="$IMAGE_REPOSITORY" -v tag="$IMAGE_TAG" -v defaultData="$default_data" '
    function reject() { invalid=1; exit 1 }
    BEGIN { data=defaultData; repo="led-control-gateway"; imageTag="local"; single=sprintf("%c",39) }
    {
      raw=$0; line=raw; sub(/^[ \t]*/,"",line)
      if (line=="" || substr(line,1,1)=="#") { if(mode=="rewrite") print raw; next }
      if (line !~ /^[A-Za-z_][A-Za-z_0-9]*[ \t]*=/) reject()
      key=line; sub(/[ \t]*=.*/,"",key)
      value=line; sub(/^[^=]*=[ \t]*/,"",value)
      quote=substr(value,1,1)
      if (quote==single || quote=="\"") {
        closeAt=0; escaped=0
        for(i=2;i<=length(value);i++) {
          c=substr(value,i,1)
          if(!escaped && c==quote) { closeAt=i; break }
          if(!escaped && c=="\\") escaped=1; else escaped=0
        }
        if(!closeAt) reject()
        rest=substr(value,closeAt+1); sub(/^[ \t]*/,"",rest)
        if(rest!="" && substr(rest,1,1)!="#") reject()
        value=substr(value,2,closeAt-2)
      } else { sub(/[ \t]+#.*/,"",value); sub(/[ \t]*$/,"",value) }
      if(key=="GATEWAY_DATA_DIR") {
        if(++dataCount>1 || value !~ /^\/[A-Za-z0-9_.\/+ -]+$/ || value ~ / /) reject()
        data=value
      }
      if(key=="GATEWAY_IMAGE_REPOSITORY") { repo=value; repoCount++ }
      if(key=="GATEWAY_IMAGE_TAG") { imageTag=value; tagCount++ }
      if(mode=="rewrite" && key=="GATEWAY_IMAGE_REPOSITORY") { if(repoCount==1) print key "=" repository; next }
      if(mode=="rewrite" && key=="GATEWAY_IMAGE_TAG") { if(tagCount==1) print key "=" tag; next }
      if(mode=="rewrite") print raw
    }
    END {
      if(invalid) exit 1
      if(mode=="resolve") {
        if(repo !~ /^[a-z0-9][a-z0-9._:\/-]*$/ || imageTag !~ /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/) exit 1
        print data "|" repo "|" imageTag
      }
      if(mode=="rewrite") { if(!repoCount) print "GATEWAY_IMAGE_REPOSITORY=" repository; if(!tagCount) print "GATEWAY_IMAGE_TAG=" tag }
    }
  ' "$file"
}
resolve_site() {
  local resolved
  resolved=$(site_dotenv resolve "$1") || { error 'unsupported site dotenv (single-line assignments required)'; return 1; }
  IFS='|' read -r DATA_DIR SITE_IMAGE_REPOSITORY SITE_IMAGE_TAG <<< "$resolved"
  safe_directory "$DATA_DIR"
}
identity_preflight() {
  local name target generation
  resolve_site "$ROOT/.env.appliance" || return 1
  for name in gateway mesh identity factory-trust; do safe_directory "$DATA_DIR/$name" || return 1; done
  safe_directory "$DATA_DIR/identity/device" && safe_directory "$DATA_DIR/identity/device/generations" || return 1
  [ -L "$DATA_DIR/identity/device/current" ] || return 1
  target=$(readlink "$DATA_DIR/identity/device/current") || return 1
  [[ "$target" =~ ^generations/[A-Za-z0-9_-]+$ ]] || return 1
  generation=$DATA_DIR/identity/device/$target; safe_directory "$generation" || return 1
  for name in device.crt device.key api-ca.crt mqtt-ca.crt; do regular "$generation/$name" && [ -s "$generation/$name" ] || return 1; done
  [ "$(file_mode "$generation/device.key")" = 600 ] || return 1
  regular "$DATA_DIR/factory-trust/api-ca.crt" && [ -s "$DATA_DIR/factory-trust/api-ca.crt" ]
}
runtime_compose() {
  local directory=$1 temporary; safe_directory "$ROOT/runtime" || return 1
  temporary=$(mktemp "$ROOT/runtime/.compose.XXXXXX") || return 1
  # --project-directory resolves env_file at the site root; resolve seccomp
  # explicitly against this release without putting secrets in immutable files.
  sed "s|seccomp=./docker/seccomp-bluez-mesh.json|seccomp=$directory/docker/seccomp-bluez-mesh.json|g" "$directory/compose.yml" > "$temporary" || return 1
  chmod 600 "$temporary" && durable "$temporary" && mv -Tf -- "$temporary" "$ROOT/runtime/$RELEASE_ID.yml" && durable "$ROOT/runtime" || return 1
  COMPOSE_FILE=$ROOT/runtime/$RELEASE_ID.yml
}
docker_cmd() {
  local seconds=$1; shift
  # All Docker boundaries (including recovery) have wall-clock + forced-kill
  # deadlines. Bundle image coordinates and the validated site data root are
  # authoritative, regardless of the invoking shell/Compose ambient settings.
  timeout --signal=TERM --kill-after="${KILL_SECONDS}s" "${seconds}s" env \
    -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_ENV_FILES -u COMPOSE_PROFILES \
    GATEWAY_DATA_DIR="$DATA_DIR" GATEWAY_IMAGE_REPOSITORY="$IMAGE_REPOSITORY" GATEWAY_IMAGE_TAG="$IMAGE_TAG" docker "$@"
}
compose_output() { docker_cmd "$COMPOSE_SECONDS" compose --project-name "$COMPOSE_PROJECT" --project-directory "$ROOT" --env-file "$ROOT/.env.appliance" -f "$COMPOSE_FILE" "$@"; }
compose() { compose_output "$@" >/dev/null 2>&1; }
ownership_preflight() {
  local ids ownership project service directory
  ids=$(docker_cmd "$METADATA_SECONDS" container ls -a --filter 'name=^/led-control-gateway$' --format '{{.ID}}' 2>/dev/null) || return 1
  if [ -z "$ids" ]; then COMPOSE_PROJECT=${EXPECTED_PROJECT:-gateway}; return 0; fi
  [[ "$ids" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  ownership=$(docker_cmd "$METADATA_SECONDS" container inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$ids" 2>/dev/null) || return 1
  IFS='|' read -r project service directory <<< "$ownership"
  case "$project" in gateway|led-control-gateway) ;; *) return 1 ;; esac
  [ "$service" = gateway-appliance ] && [ "$directory" = "$ROOT" ] || return 1
  [ -z "$EXPECTED_PROJECT" ] || [ "$project" = "$EXPECTED_PROJECT" ] || return 1
  # A legacy service is not a first install: without a verified current bundle
  # we cannot restore it after failure. A validated active journal is different:
  # it can legitimately own a first-install candidate that recovery must stop.
  if [ "$OLD_CURRENT" = none ] && [ "$JOURNAL_ACTIVE" = 0 ]; then
    error 'existing service has no verified baseline; baseline migration or registration is required before activation'
    return 1
  fi
  COMPOSE_PROJECT=$project
}
validate_loaded_image() {
  local loaded revision version policy test_mode expected_test=false extra
  LOADED_IMAGE_DIGEST=""
  if [ -z "$IMAGE_DESCRIPTOR_DIGEST" ]; then
    [ "$1" = "$IMAGE_DIGEST" ] || return 1
    LOADED_IMAGE_DIGEST=$1; return 0
  fi
  [ "$TEST_MODE" != 1 ] || expected_test=true
  IFS='|' read -r loaded revision version policy test_mode extra <<< "$1"
  [[ "$loaded" =~ ^sha256:[a-f0-9]{64}$ ]] && [ -z "$extra" ] || return 1
  [ "$1" = "$loaded|$COMMIT|$VERSION|$POLICY_SHA|$expected_test" ] || return 1
  [ "$loaded" = "$IMAGE_DIGEST" ] || [ "$loaded" = "$IMAGE_DESCRIPTOR_DIGEST" ] || return 1
  LOADED_IMAGE_DIGEST=$loaded
}
resolve_loaded_image() {
  local loaded format='{{.Id}}'
  if [ -n "$IMAGE_DESCRIPTOR_DIGEST" ]; then
    format='{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "com.led-control.release-policy-sha256"}}|{{index .Config.Labels "com.led-control.release.test-mode"}}'
  fi
  loaded=$(docker_cmd "$METADATA_SECONDS" image inspect --format "$format" "$IMAGE_REPOSITORY:$IMAGE_TAG" 2>/dev/null) && validate_loaded_image "$loaded"
}
preflight() {
  local directory=$1 images
  identity_preflight && ownership_preflight && docker_cmd "$METADATA_SECONDS" version >/dev/null 2>&1 && docker_cmd "$METADATA_SECONDS" compose version >/dev/null 2>&1 && runtime_compose "$directory" || return 1
  compose config --quiet || return 1
  images=$(compose_output config --images 2>/dev/null) || return 1
  [ "$images" = "$IMAGE_REPOSITORY:$IMAGE_TAG" ] || return 1
  docker_cmd "$LOAD_SECONDS" image load --input "$directory/$IMAGE_ARCHIVE" >/dev/null 2>&1 || return 1
  resolve_loaded_image
}
healthy() {
  local step status attempts=60 delay=2
  if [ "$TEST_ROOT" = 1 ]; then attempts=2; delay=0; fi
  for ((step=0; step<attempts; step++)); do
    status=$(docker_cmd "$METADATA_SECONDS" inspect --format '{{.Image}} {{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' led-control-gateway 2>/dev/null) || return 1
    [ -n "$LOADED_IMAGE_DIGEST" ] && [ "${status%% *}" = "$LOADED_IMAGE_DIGEST" ] || return 1
    status=${status#* }; [ "$status" != unhealthy ] || return 1; [ "$status" != healthy ] || return 0; sleep "$delay"
  done
  return 1
}

operation_lock() {
  if [ -e "$ROOT/.appliance-operation.lock" ] || [ -L "$ROOT/.appliance-operation.lock" ]; then
    regular "$ROOT/.appliance-operation.lock" || { error 'unsafe operation lock'; return 1; }
  fi
  exec 9>>"$ROOT/.appliance-operation.lock"
  flock -n 9 || { echo 'appliance operation already running' >&2; return 4; }
}
