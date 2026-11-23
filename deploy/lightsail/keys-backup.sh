#!/usr/bin/env bash
# Backs up the server's keys (/data/keys) to their own S3 bucket, apart from the database backup. See
# docs/deploy-aws-lightsail.md, "Keys". Runs in the keys-backup and keys-restore containers (amazon/aws-cli).
#
#   backup   (default) upload the keys now and whenever they change; checks every KEYS_BACKUP_CHECK_INTERVAL seconds.
#            Only needs s3:PutObject on the bucket, so the server's AWS key can't read the keys back.
#   restore  download them into /data/keys. Needs read access: run it with your own AWS credentials.
set -euo pipefail

KEYS_DIR=/data/keys
BUCKET="${KEYS_BACKUP_BUCKET:-}"
PREFIX="s3://${BUCKET}/keys"
INTERVAL="${KEYS_BACKUP_CHECK_INTERVAL:-3600}"

if [[ -z "$BUCKET" ]]; then
  echo "KEYS_BACKUP_BUCKET isn't set, so the server's keys aren't backed up. After restoring the database onto a new"
  echo "instance, sign-in providers added on the Admin page and saved integration secrets would need entering again."
  echo "See docs/deploy-aws-lightsail.md, \"Keys\"."
  exit 0
fi

fingerprint() {
  (cd "$KEYS_DIR" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) | sha256sum | cut -d' ' -f1
}

case "${1:-backup}" in
  backup)
    last=""
    while true; do
      if [[ -d "$KEYS_DIR" ]] && [[ -n "$(find "$KEYS_DIR" -type f -print -quit)" ]]; then
        current="$(fingerprint)"
        if [[ "$current" != "$last" ]]; then
          # cp, not sync: sync lists the bucket, and this key may only write to it.
          if aws s3 cp --recursive --only-show-errors "$KEYS_DIR" "$PREFIX/"; then
            echo "$(date -u +%FT%TZ) keys backed up to $PREFIX/"
            last="$current"
          else
            echo "$(date -u +%FT%TZ) couldn't upload the keys to $PREFIX/; trying again later" >&2
          fi
        fi
      fi
      sleep "$INTERVAL"
    done
    ;;
  restore)
    mkdir -p "$KEYS_DIR"
    aws s3 cp --recursive --only-show-errors "$PREFIX/" "$KEYS_DIR/"
    echo "Restored the keys from $PREFIX/ into $KEYS_DIR:"
    (cd "$KEYS_DIR" && find . -type f | sort)
    ;;
  *)
    echo "Usage: keys-backup.sh [backup|restore]" >&2
    exit 2
    ;;
esac
