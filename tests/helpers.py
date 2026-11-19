"""Test helpers for claudes.py.

claudes.py works on a user's real Claude Code config, so every test must run against
throwaway folders. `load_claudes` points the base, the bin folder and HOME at a temp
folder BEFORE importing the script, because the script reads them at import time.

Run the suite from the repo root:  python3 -m unittest discover -s tests -v
"""
import importlib.machinery
import importlib.util
import itertools
import os
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
_counter = itertools.count()


def load_claudes(testcase):
    """Import a fresh copy of claudes.py bound to a new temp folder.

    Returns (module, tmp) where tmp is a Path holding `base/`, `bin/` and `home/`.
    The environment and the temp folder are restored/removed when the test ends.
    """
    tmp_ctx = tempfile.TemporaryDirectory(prefix="claudes-test-")
    testcase.addCleanup(tmp_ctx.cleanup)
    tmp = Path(tmp_ctx.name).resolve()
    for name in ("base", "bin", "home"):
        (tmp / name).mkdir()
    saved = {k: os.environ.get(k) for k in ("CLAUDES_BASE", "CLAUDES_BIN_DIR", "HOME", "CLAUDE_CONFIG_DIR")}

    def restore():
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    testcase.addCleanup(restore)
    os.environ["CLAUDES_BASE"] = str(tmp / "base")
    os.environ["CLAUDES_BIN_DIR"] = str(tmp / "bin")
    os.environ["HOME"] = str(tmp / "home")
    os.environ.pop("CLAUDE_CONFIG_DIR", None)

    loader = importlib.machinery.SourceFileLoader(f"claudes_under_test_{next(_counter)}", str(REPO / "claudes.py"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    assert str(module.BASE) == str(tmp / "base"), "claudes.py is not bound to the temp base"
    assert str(module.HOME) == str(tmp / "home"), "claudes.py is not bound to the temp home"
    return module, tmp


def write(path, text=""):
    """Create a file (and its parent folders) with the given text."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path
