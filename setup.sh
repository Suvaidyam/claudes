#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${CLAUDES_BASE:-$HOME/.claudes}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required but was not found on PATH." >&2
    exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
    echo "Warning: the 'claude' CLI was not found on PATH." >&2
    echo "Install/log in to Claude Code before using 'claudes launch|switch|usage|best'." >&2
fi

# Only when requirements.txt lists a package: an empty one would still make pip
# fail on an externally managed Python (Homebrew, PEP 668) and stop setup.
if [ -f "$SCRIPT_DIR/requirements.txt" ] && grep -qvE '^[[:space:]]*(#|$)' "$SCRIPT_DIR/requirements.txt"; then
    if python3 -m pip --version >/dev/null 2>&1; then
        echo "Installing dependencies from requirements.txt"
        python3 -m pip install --user -r "$SCRIPT_DIR/requirements.txt"
    else
        echo "Warning: pip not available; skipping requirements.txt install." >&2
    fi
fi

echo "Running installer: python3 $SCRIPT_DIR/claudes.py install"
python3 "$SCRIPT_DIR/claudes.py" install

NEEDS_RELAUNCH=0
RC_FILE=""
PATH_LINE="export PATH=\"\$HOME/bin:\$HOME/.claudes:\$PATH\""

choose_rc_file() {
    case "${SHELL:-}" in
        */zsh) RC_FILE="$HOME/.zshrc" ;;
        */bash) RC_FILE="$HOME/.bash_profile" ;;
        *) RC_FILE="$HOME/.profile" ;;
    esac
}

add_path_line() {
    choose_rc_file
    if [ ! -f "$RC_FILE" ] || ! grep -qF "$PATH_LINE" "$RC_FILE"; then
        {
            echo ""
            echo "$PATH_LINE"
        } >> "$RC_FILE"
        echo "Added PATH entry to $RC_FILE"
    fi
    NEEDS_RELAUNCH=1
}

# The ideate command, when claudes.py install set it up and it isn't on PATH yet.
# Never fails: setup must finish for people whose 'claudes' already works.
link_ideate() {
    local wrapper="$BASE_DIR/marketplace/ideate"
    [ -f "$wrapper" ] || return 0
    local found
    found="$(command -v ideate 2>/dev/null || true)"
    if [ -n "$found" ] && [ "$found" -ef "$wrapper" ]; then
        return 0
    fi
    echo
    if [ -n "$found" ]; then
        echo "Note: a different 'ideate' is earlier on PATH: $found"
    fi
    if [ -e "$HOME/bin/ideate" ] && [ ! -L "$HOME/bin/ideate" ]; then
        echo "ideate: ~/bin/ideate exists and is not a link; left as it is"
        return 0
    fi
    mkdir -p "$HOME/bin" && ln -sfn "$wrapper" "$HOME/bin/ideate" || { echo "ideate: could not link the command into ~/bin; skipped"; return 0; }
    echo "Linked: $HOME/bin/ideate -> $wrapper"
    # add_path_line's exit status can't be trusted (bash 3.2 carries on past a
    # failed append), so check first that the rc file can be appended to.
    choose_rc_file
    if grep -qsF "$PATH_LINE" "$RC_FILE" \
        || { [ -e "$RC_FILE" ] && [ -w "$RC_FILE" ]; } \
        || { [ ! -e "$RC_FILE" ] && [ -w "${RC_FILE%/*}" ]; }; then
        add_path_line || true
    else
        echo "ideate: could not add ~/bin to PATH in $RC_FILE"
    fi
}

if command -v claudes >/dev/null 2>&1; then
    echo
    echo "'claudes' is on PATH: $(command -v claudes)"
else
    echo
    echo "'claudes' isn't on PATH yet (likely /usr/local/bin isn't writable without sudo)."
    echo "Setting up a no-sudo fallback..."

    mkdir -p "$HOME/bin"
    ln -sf "$BASE_DIR/claudes" "$HOME/bin/claudes"
    echo "Linked: $HOME/bin/claudes -> $BASE_DIR/claudes"

    add_path_line
fi

link_ideate

echo
echo "Base directory : $BASE_DIR"
echo "Next steps:"
echo "    claudes list"
echo "    claudes add <name>"

if [ "$NEEDS_RELAUNCH" = "1" ]; then
    echo
    if [ -t 0 ]; then
        echo "Relaunching your shell so 'claudes' is ready to use..."
        echo "(any per-terminal state from before setup, like cd or an activated venv, resets - same as opening a new tab)"
        exec "$SHELL" -li
    else
        echo "Restart your terminal (or run: source $RC_FILE), then 'claudes' will be available."
    fi
fi
