"""Tests for setup_shared_links / migrate: linking must never delete anything."""
import ast
import contextlib
import io
import json
import os
import sys
import unittest
from pathlib import Path

from tests.helpers import REPO, load_claudes, write


def snapshot(root):
    """Every path under root with its kind and content (or link target)."""
    out = {}
    root = Path(root)
    for dirpath, dirnames, filenames in os.walk(root):
        for n in dirnames + filenames:
            p = Path(dirpath) / n
            rel = str(p.relative_to(root))
            if p.is_symlink():
                out[rel] = ("link", os.readlink(p))
            elif p.is_dir():
                out[rel] = ("dir",)
            else:
                try:
                    out[rel] = ("file", p.read_bytes(), oct(p.stat().st_mode))
                except PermissionError:
                    out[rel] = ("file-unreadable", oct(p.stat().st_mode))
    return out


def backups(parent, name):
    return sorted(p for p in Path(parent).iterdir() if p.name.startswith(name + ".pre-claudes-"))


class LinkingBase(unittest.TestCase):
    def setUp(self):
        self.c, self.tmp = load_claudes(self)
        self.c.ensure()
        self.shared = self.c.SHARED
        self.profile = self.tmp / "profiles-test" / "work"
        self.profile.mkdir(parents=True)

    def link(self, path=None, **kw):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            res = self.c.setup_shared_links(str(path or self.profile), **kw)
        self.out = buf.getvalue()
        return res

    def assertLinked(self, name, path=None):
        item = Path(path or self.profile) / name
        self.assertTrue(item.is_symlink(), f"{name} is not a symlink")
        self.assertEqual(item.resolve(), (self.shared / name).resolve())


class ProjectsTests(LinkingBase):
    def make_project(self):
        proj = self.profile / "projects" / "-Users-x-app"
        write(proj / "s1.jsonl", '{"a":1}\n')
        write(proj / "memory" / "MEMORY.md", "- [Note](note.md)\n")
        write(proj / "memory" / "note.md", "remember this\n")
        write(proj / "s1" / "subagents" / "agent-1.jsonl", '{"sub":1}\n')
        write(proj / "notes.txt", "loose\n")
        return proj

    def test_whole_tree_copied_and_original_kept(self):
        self.make_project()
        before = snapshot(self.profile / "projects")
        res = self.link()
        sp = self.shared / "projects" / "-Users-x-app"
        self.assertEqual((sp / "memory" / "note.md").read_text(), "remember this\n")
        self.assertEqual((sp / "memory" / "MEMORY.md").read_text(), "- [Note](note.md)\n")
        self.assertEqual((sp / "s1" / "subagents" / "agent-1.jsonl").read_text(), '{"sub":1}\n')
        self.assertEqual((sp / "notes.txt").read_text(), "loose\n")
        self.assertEqual((sp / "s1.jsonl").read_text(), '{"a":1}\n')
        self.assertLinked("projects")
        [bk] = backups(self.profile, "projects")
        self.assertEqual(snapshot(bk), before)
        self.assertEqual(res["projects"]["backup"], str(bk))
        self.assertEqual(res["projects"]["copied"], 5)
        self.assertEqual(res["projects"]["conflicts"], [])
        self.assertTrue(res["projects"]["linked"])
        self.assertIsNone(res["projects"]["error"])
        self.assertIn(str(bk), self.out)

    def test_conflicting_session_kept_and_reported(self):
        proj = self.make_project()
        write(self.shared / "projects" / "-Users-x-app" / "s1.jsonl", '{"shared":1}\n')
        res = self.link()
        self.assertEqual((self.shared / "projects" / "-Users-x-app" / "s1.jsonl").read_text(), '{"shared":1}\n')
        [bk] = backups(self.profile, "projects")
        self.assertEqual((bk / "-Users-x-app" / "s1.jsonl").read_text(), '{"a":1}\n')
        rel = os.path.join("-Users-x-app", "s1.jsonl")
        self.assertEqual(res["projects"]["conflicts"], [rel])
        self.assertIn(rel, self.out)
        self.assertLinked("projects")

    def test_identical_file_not_a_conflict(self):
        self.make_project()
        write(self.shared / "projects" / "-Users-x-app" / "s1.jsonl", '{"a":1}\n')
        res = self.link()
        self.assertEqual(res["projects"]["conflicts"], [])
        self.assertEqual(res["projects"]["copied"], 4)

    def test_memory_index_merged(self):
        proj = self.make_project()
        write(proj / "memory" / "MEMORY.md",
              "# Memory\n- [Note](note.md)\n- [Other name](shared.md)\n\n- [New](new.md)\nplain line\n")
        write(self.shared / "projects" / "-Users-x-app" / "memory" / "MEMORY.md",
              "# Memory\n- [Shared](shared.md)\n")
        res = self.link()
        merged = (self.shared / "projects" / "-Users-x-app" / "memory" / "MEMORY.md").read_text()
        lines = merged.splitlines()
        self.assertEqual(lines[:2], ["# Memory", "- [Shared](shared.md)"])
        self.assertIn("- [Note](note.md)", lines)
        self.assertIn("- [New](new.md)", lines)
        self.assertIn("plain line", lines)
        self.assertNotIn("- [Other name](shared.md)", lines)
        self.assertEqual(lines.count("# Memory"), 1)
        self.assertEqual(res["projects"]["merged"], 1)
        self.assertEqual(res["projects"]["conflicts"], [])
        [bk] = backups(self.profile, "projects")
        self.assertIn("[New](new.md)", (bk / "-Users-x-app" / "memory" / "MEMORY.md").read_text())

    def test_symlink_inside_tree_copied_as_link(self):
        proj = self.make_project()
        os.symlink("/nonexistent/target", proj / "dangling")
        res = self.link()
        dst = self.shared / "projects" / "-Users-x-app" / "dangling"
        self.assertTrue(dst.is_symlink())
        self.assertEqual(os.readlink(dst), "/nonexistent/target")
        self.assertIsNone(res["projects"]["error"])

    def test_failed_copy_keeps_folder_and_links_others(self):
        if os.geteuid() == 0:
            self.skipTest("root can read chmod 000 files")
        proj = self.make_project()
        bad = proj / "memory" / "note.md"
        os.chmod(bad, 0)
        self.addCleanup(os.chmod, bad, 0o644)
        write(self.profile / "plugins" / "p.json", "{}")
        res = self.link()
        self.assertTrue((self.profile / "projects").is_dir())
        self.assertFalse((self.profile / "projects").is_symlink())
        self.assertEqual(backups(self.profile, "projects"), [])
        self.assertFalse(res["projects"]["linked"])
        self.assertTrue(res["projects"]["error"])
        self.assertIn("note.md", self.out)
        self.assertLinked("plugins")
        self.assertLinked("cache")
        self.assertLinked("history.jsonl")
        self.assertLinked("settings.json")

    def test_second_run_changes_nothing(self):
        self.make_project()
        write(self.profile / "plugins" / "a.json", "1")
        write(self.profile / "history.jsonl", '{"sessionId":"s","timestamp":1}\n')
        write(self.profile / "settings.json", '{"x":1}')
        self.link()
        before = snapshot(self.tmp)
        res = self.link()
        self.assertEqual(snapshot(self.tmp), before)
        for r in res.values():
            self.assertIsNone(r["backup"])

    def test_backup_name_collision(self):
        self.make_project()
        self.c._timestamp = lambda: "20260101-000000"
        (self.profile / "projects.pre-claudes-20260101-000000").mkdir()
        self.link()
        self.assertTrue((self.profile / "projects.pre-claudes-20260101-000000-2" / "-Users-x-app" / "s1.jsonl").is_file())
        self.assertLinked("projects")

    def test_dry_run_changes_nothing(self):
        self.make_project()
        write(self.profile / "plugins" / "a.json", "1")
        write(self.profile / "history.jsonl", '{"sessionId":"s","timestamp":1}\n')
        write(self.profile / "settings.json", '{"x":1}')
        write(self.shared / "projects" / "-Users-x-app" / "s1.jsonl", "different\n")
        before = snapshot(self.tmp)
        res = self.link(dry_run=True)
        self.assertEqual(snapshot(self.tmp), before)
        self.assertEqual(res["projects"]["copied"], 4)
        self.assertEqual(res["projects"]["conflicts"], [os.path.join("-Users-x-app", "s1.jsonl")])
        self.assertIn("dry run", self.out.lower())
        self.assertIn("projects", self.out)

    def test_dry_run_without_shared_layer(self):
        c, tmp = load_claudes(self)
        prof = tmp / "p"
        write(prof / "projects" / "x" / "a.jsonl", "1")
        before = snapshot(tmp)
        with contextlib.redirect_stdout(io.StringIO()):
            res = c.setup_shared_links(str(prof), dry_run=True)
        self.assertEqual(snapshot(tmp), before)
        self.assertEqual(res["projects"]["copied"], 1)

    def test_active_session_skips(self):
        self.make_project()
        write(self.profile / "sessions" / f"{os.getpid()}.json", "{}")
        before = snapshot(self.tmp)
        self.link()
        self.assertEqual(snapshot(self.tmp), before)
        self.assertIn("Skipping", self.out)
        self.assertIn("Claude is running under it", self.out)

    def test_active_session_nothing_to_merge_still_links_missing(self):
        write(self.profile / "sessions" / f"{os.getpid()}.json", "{}")
        self.link()
        self.assertLinked("projects")


class OtherItemsTests(LinkingBase):
    def test_plugins_conflict_kept(self):
        write(self.profile / "plugins" / "installed_plugins.json", '{"mine":1}')
        write(self.profile / "plugins" / "only-mine" / "x.txt", "x")
        write(self.shared / "plugins" / "installed_plugins.json", '{"shared":1}')
        res = self.link()
        self.assertEqual((self.shared / "plugins" / "installed_plugins.json").read_text(), '{"shared":1}')
        self.assertEqual((self.shared / "plugins" / "only-mine" / "x.txt").read_text(), "x")
        [bk] = backups(self.profile, "plugins")
        self.assertEqual((bk / "installed_plugins.json").read_text(), '{"mine":1}')
        self.assertEqual(res["plugins"]["conflicts"], ["installed_plugins.json"])
        self.assertIn("installed_plugins.json", self.out)
        self.assertLinked("plugins")

    def test_settings_kept_when_shared_nonempty(self):
        write(self.shared / "settings.json", '{"shared":true}')
        write(self.profile / "settings.json", '{"mine":true}')
        res = self.link()
        self.assertEqual((self.shared / "settings.json").read_text(), '{"shared":true}')
        [bk] = backups(self.profile, "settings.json")
        self.assertEqual(bk.read_text(), '{"mine":true}')
        self.assertEqual(res["settings.json"]["backup"], str(bk))
        self.assertLinked("settings.json")

    def test_settings_copied_when_shared_empty(self):
        write(self.shared / "settings.json", "{}")
        write(self.profile / "settings.json", '{"mine":true}')
        self.link()
        self.assertEqual((self.shared / "settings.json").read_text(), '{"mine":true}')
        [bk] = backups(self.profile, "settings.json")
        self.assertEqual(bk.read_text(), '{"mine":true}')
        self.assertLinked("settings.json")

    def test_history_kept_with_unparseable_line(self):
        text = '{"sessionId":"a","timestamp":1}\nnot json at all\n'
        write(self.profile / "history.jsonl", text)
        self.link()
        [bk] = backups(self.profile, "history.jsonl")
        self.assertEqual(bk.read_text(), text)
        self.assertIn('"sessionId":"a"', (self.shared / "history.jsonl").read_text())
        self.assertLinked("history.jsonl")

    def test_wrong_symlink_replaced(self):
        other = self.tmp / "elsewhere"
        other.mkdir()
        os.symlink(other, self.profile / "cache")
        self.link()
        self.assertLinked("cache")
        self.assertTrue(other.is_dir())


class MergeProjectsCopyTests(LinkingBase):
    def test_copy_mode_never_deletes(self):
        src = self.tmp / "old" / "projects"
        write(src / "p" / "a.jsonl", "1")
        before = snapshot(src)
        n = self.c._merge_projects(src, self.shared / "projects")
        self.assertEqual(n, 1)
        self.assertEqual(snapshot(src), before)
        self.assertEqual((self.shared / "projects" / "p" / "a.jsonl").read_text(), "1")


class MigrateTests(unittest.TestCase):
    def setUp(self):
        self.c, self.tmp = load_claudes(self)
        dc = self.tmp / "home" / ".claude"
        write(dc / "projects" / "-x" / "memory" / "MEMORY.md", "- [A](a.md)\n")
        write(dc / "projects" / "-x" / "memory" / "a.md", "A\n")
        write(dc / "projects" / "-x" / "s.jsonl", "{}\n")
        write(dc / "settings.json", '{"m":1}')
        old = self.tmp / "home" / ".claudes" / "acc1" / "projects" / "-y" / "old.jsonl"
        write(old, "{}\n")
        write(self.tmp / "base" / "accounts.json",
              json.dumps({"accounts": [{"name": "acc1", "config_path": str(self.tmp / "base" / "profiles" / "acc1")}]}))
        (self.tmp / "base" / "profiles" / "acc1").mkdir(parents=True)
        self.dc = dc

    def run_migrate(self, **kw):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.c.migrate(**kw)
        return buf.getvalue()

    def test_dry_run_changes_nothing(self):
        before = snapshot(self.tmp)
        out = self.run_migrate(dry_run=True)
        self.assertEqual(snapshot(self.tmp), before)
        self.assertIn(str(self.tmp / "home" / ".claudes" / "acc1"), out)
        self.assertIn("projects", out)

    def test_migrate_links_default_config_without_loss(self):
        self.run_migrate()
        sp = self.c.SHARED / "projects"
        self.assertEqual((sp / "-x" / "memory" / "a.md").read_text(), "A\n")
        self.assertEqual((sp / "-x" / "memory" / "MEMORY.md").read_text(), "- [A](a.md)\n")
        self.assertEqual((sp / "-y" / "old.jsonl").read_text(), "{}\n")
        self.assertTrue((self.dc / "projects").is_symlink())
        [bk] = backups(self.dc, "projects")
        self.assertEqual((bk / "-x" / "memory" / "a.md").read_text(), "A\n")
        self.assertTrue((self.tmp / "base" / "profiles" / "acc1" / "projects").is_symlink())
        self.assertTrue((self.tmp / "home" / ".claudes" / "acc1" / "projects" / "-y" / "old.jsonl").is_file())

    def test_cli_dry_run(self):
        import subprocess
        env = dict(os.environ)
        before = snapshot(self.tmp)
        r = subprocess.run([sys.executable, str(REPO / "claudes.py"), "migrate", "--dry-run"],
                           env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(snapshot(self.tmp), before)
        self.assertIn("dry run", r.stdout.lower())


class StdlibOnlyTests(unittest.TestCase):
    def test_imports_are_stdlib(self):
        tree = ast.parse((REPO / "claudes.py").read_text())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names.add(node.module.split(".")[0])
        self.assertTrue(names)
        self.assertEqual(names - set(sys.stdlib_module_names), set())


if __name__ == "__main__":
    unittest.main()
