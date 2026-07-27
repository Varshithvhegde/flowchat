#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/partialupdate-dev.XXXXXX")"
env_file="$tmp_dir/.dev.vars"
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
	rm -rf "$tmp_dir"
}

trap cleanup EXIT INT TERM

keychain_value() {
	security find-generic-password -a "frontclaw" -s "$1" -w 2>/dev/null || true
}

quote_dotenv() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

append_keychain_value() {
	local key="$1"
	local value

	value="$(keychain_value "$key")"

	if [[ -n "$value" ]]; then
		printf '%s="%s"\n' "$key" "$(quote_dotenv "$value")" >> "$env_file"
	fi
}

if [[ -f "$project_dir/.env" ]]; then
	cp "$project_dir/.env" "$env_file"
else
	: > "$env_file"
fi
printf '\n' >> "$env_file"

append_keychain_value CLOUDFLARE_API_TOKEN
append_keychain_value CLOUDFLARE_AI_GATEWAY_ID
append_keychain_value CLOUDFLARE_ACCOUNT_ID
append_keychain_value GEMINI_API_KEY
append_keychain_value INCEPTION_API_KEY
append_keychain_value BETTER_AUTH_SECRET
append_keychain_value GITHUB_CLIENT_ID
append_keychain_value GITHUB_CLIENT_SECRET
append_keychain_value GOOGLE_CLIENT_ID
append_keychain_value GOOGLE_CLIENT_SECRET
append_keychain_value INCEPTION_API_KEY

chmod 600 "$env_file"

exec wrangler dev --local --ip 0.0.0.0 --env-file "$env_file" "$@"
