"""Tests for setup_shared_links / migrate: linking must never delete anything."""
import ast
import contextlib
import io
import json
import os
import sys
import time
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
        os.symlink(str(self.tmp), proj / "abs")
        os.symlink("note.md", proj / "memory" / "rel-ok")
        os.symlink("/nonexistent/target", proj / "dangling")
        os.symlink("../../../../outside-thing", proj / "memory" / "rel-bad")
        write(self.tmp / "profiles-test" / "outside-thing", "x")
        res = self.link()
        sp = self.shared / "projects" / "-Users-x-app"
        self.assertTrue((sp / "abs").is_symlink())
        self.assertEqual(os.readlink(sp / "abs"), str(self.tmp))
        self.assertEqual(os.readlink(sp / "memory" / "rel-ok"), "note.md")
        self.assertFalse(os.path.lexists(sp / "dangling"))
        self.assertFalse(os.path.lexists(sp / "memory" / "rel-bad"))
        self.assertEqual(sorted(res["projects"]["backup_only"]),
                         [os.path.join("-Users-x-app", "dangling"), os.path.join("-Users-x-app", "memory", "rel-bad")])
        self.assertIn("only in the backup", self.out)
        self.assertIsNone(res["projects"]["error"])
        self.assertLinked("projects")
        [bk] = backups(self.profile, "projects")
        self.assertTrue((bk / "-Users-x-app" / "memory" / "rel-bad").is_symlink())

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


def partials(root):
    return [os.path.join(dp, n) for dp, dn, fn in os.walk(root) for n in fn + dn if n.endswith(".claudes-partial")]


class SharedLayerGuardTests(LinkingBase):
    """C1: never link the shared layer onto itself."""

    def seed_shared(self):
        write(self.shared / "projects" / "-s" / "keep.jsonl", "keep\n")
        return snapshot(self.shared)

    def test_profile_is_shared_refused(self):
        before = self.seed_shared()
        res = self.link(self.shared)
        self.assertEqual(snapshot(self.shared), before)
        self.assertIn("Refusing", self.out)
        self.assertTrue(all(r["error"] and "refused" in r["error"] for r in res.values()))
        self.assertEqual(self.out.strip().count("\n"), 0)

    def test_profile_symlink_to_shared_refused(self):
        before = self.seed_shared()
        lnk = self.tmp / "lnk"
        os.symlink(self.shared, lnk)
        res = self.link(lnk)
        self.assertEqual(snapshot(self.shared), before)
        self.assertIn("refused", res["projects"]["error"])

    def test_profile_containing_shared_refused(self):
        before = self.seed_shared()
        res = self.link(self.c.BASE)
        self.assertEqual(snapshot(self.shared), before)
        self.assertIn("refused", res["projects"]["error"])

    def test_profile_inside_shared_refused(self):
        inner = self.shared / "projects" / "-inner"
        inner.mkdir(parents=True)
        before = snapshot(self.shared)
        res = self.link(inner)
        self.assertEqual(snapshot(self.shared), before)
        self.assertIn("refused", res["projects"]["error"])

    def test_shared_item_is_link_to_profile_item(self):
        write(self.profile / "projects" / "-p" / "a.jsonl", "a\n")
        os.rmdir(self.shared / "projects")
        os.symlink(self.profile / "projects", self.shared / "projects")
        res = self.link()
        self.assertTrue((self.profile / "projects").is_dir())
        self.assertFalse((self.profile / "projects").is_symlink())
        self.assertEqual(backups(self.profile, "projects"), [])
        self.assertTrue(res["projects"]["error"])
        self.assertIn("same", self.out)
        self.assertLinked("plugins")

    def test_migrate_with_shared_as_account(self):
        self.seed_shared()
        acc = [{"name": "bad", "config_path": str(self.shared)},
               {"name": "ok", "config_path": str(self.profile)}]
        self.c.ACCOUNTS.write_text(json.dumps({"accounts": acc}))
        with contextlib.redirect_stdout(io.StringIO()):
            self.c.migrate()
        self.assertTrue((self.shared / "projects").is_dir())
        self.assertFalse((self.shared / "projects").is_symlink())
        self.assertEqual((self.shared / "projects" / "-s" / "keep.jsonl").read_text(), "keep\n")
        self.assertEqual(backups(self.shared, "projects"), [])
        self.assertLinked("projects")

    def test_ensure_survives_dangling_symlink(self):
        os.rmdir(self.shared / "projects")
        os.symlink(self.tmp / "gone", self.shared / "projects")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.c.ensure()
        self.assertIn(str(self.shared / "projects"), buf.getvalue())


class AtomicCopyTests(LinkingBase):
    """I1: a failed or interrupted copy never leaves a partial file in shared."""

    def setUp(self):
        super().setUp()
        write(self.profile / "projects" / "-p" / "big.jsonl", "0123456789" * 1000)
        self.real = self.c._copy_bytes

    def fail_with(self, exc):
        def copy(fsrc, fdst):
            fdst.write(fsrc.read(5))
            raise exc
        self.c._copy_bytes = copy

    def test_disk_full_leaves_no_partial_and_retry_succeeds(self):
        self.fail_with(OSError(28, "No space left on device"))
        res = self.link()
        dst = self.shared / "projects" / "-p" / "big.jsonl"
        self.assertFalse(os.path.lexists(dst))
        self.assertEqual(partials(self.shared), [])
        self.assertTrue(res["projects"]["error"])
        self.assertFalse((self.profile / "projects").is_symlink())
        self.c._copy_bytes = self.real
        res = self.link()
        self.assertEqual(dst.read_text(), "0123456789" * 1000)
        self.assertEqual(res["projects"]["conflicts"], [])
        self.assertLinked("projects")

    def test_ctrl_c_leaves_no_partial(self):
        self.fail_with(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt), contextlib.redirect_stdout(io.StringIO()):
            self.c.setup_shared_links(str(self.profile))
        self.assertFalse(os.path.lexists(self.shared / "projects" / "-p" / "big.jsonl"))
        self.assertEqual(partials(self.shared), [])
        self.assertFalse((self.profile / "projects").is_symlink())

    def test_leftover_partial_cleaned(self):
        old = write(self.shared / "projects" / "-p" / ".claudes-oldrun.claudes-partial", "012")
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        young = write(self.shared / "projects" / "-q" / ".claudes-otherrun.claudes-partial", "012")
        foreign = write(self.shared / "projects" / "-q" / "user-file.claudes-partial", "mine")
        os.utime(foreign, (time.time() - 3600, time.time() - 3600))
        res = self.link()
        self.assertFalse(os.path.lexists(old))
        self.assertTrue(young.is_file())
        self.assertTrue(foreign.is_file())
        self.assertEqual(res["projects"]["conflicts"], [])
        self.assertEqual((self.shared / "projects" / "-p" / "big.jsonl").read_text(), "0123456789" * 1000)

    def test_settings_copy_is_atomic(self):
        write(self.profile / "settings.json", '{"mine":1}')
        self.fail_with(OSError(28, "No space left on device"))
        res = self.link()
        self.assertEqual((self.shared / "settings.json").read_text(), "{}")
        self.assertTrue(res["settings.json"]["error"])
        self.assertFalse((self.profile / "settings.json").is_symlink())
        self.assertEqual(partials(self.shared), [])

    def test_merge_projects_copy_is_atomic(self):
        src = self.tmp / "old" / "projects"
        write(src / "-o" / "a.jsonl", "abcdefghij" * 100)
        self.fail_with(OSError(28, "No space left on device"))
        with contextlib.redirect_stdout(io.StringIO()):
            n = self.c._merge_projects(src, self.shared / "projects")
        self.assertEqual(n, 0)
        self.assertFalse(os.path.lexists(self.shared / "projects" / "-o" / "a.jsonl"))
        self.assertEqual(partials(self.shared), [])


class ForeignLinkTests(LinkingBase):
    """I2: a link that points elsewhere is kept (renamed) and its content merged."""

    def test_dir_link_elsewhere(self):
        outside = self.tmp / "outside-projects"
        write(outside / "-o" / "memory" / "m.md", "mem\n")
        before = snapshot(outside)
        os.symlink(outside, self.profile / "projects")
        res = self.link()
        self.assertEqual((self.shared / "projects" / "-o" / "memory" / "m.md").read_text(), "mem\n")
        self.assertEqual(snapshot(outside), before)
        [bk] = backups(self.profile, "projects")
        self.assertTrue(bk.is_symlink())
        self.assertEqual(os.readlink(bk), str(outside))
        self.assertIn(str(outside), self.out)
        self.assertEqual(res["projects"]["backup"], str(bk))
        self.assertLinked("projects")

    def test_file_link_elsewhere(self):
        outside = write(self.tmp / "h.jsonl", '{"sessionId":"z","timestamp":5}\n')
        os.symlink(outside, self.profile / "history.jsonl")
        self.link()
        self.assertIn('"sessionId":"z"', (self.shared / "history.jsonl").read_text())
        [bk] = backups(self.profile, "history.jsonl")
        self.assertEqual(os.readlink(bk), str(outside))
        self.assertTrue(outside.is_file())
        self.assertLinked("history.jsonl")

    def test_dangling_link_kept(self):
        os.symlink(self.tmp / "nowhere", self.profile / "cache")
        self.link()
        [bk] = backups(self.profile, "cache")
        self.assertEqual(os.readlink(bk), str(self.tmp / "nowhere"))
        self.assertLinked("cache")


class EncodingAndIsolationTests(LinkingBase):
    """I3: bad bytes and unexpected errors never abort the run."""

    def test_non_utf8_memory_index_is_conflict(self):
        p = self.profile / "projects" / "-p" / "memory" / "MEMORY.md"
        p.parent.mkdir(parents=True)
        p.write_bytes(b"- [x](x.md) \xff\xfe\n")
        write(self.shared / "projects" / "-p" / "memory" / "MEMORY.md", "- [y](y.md)\n")
        res = self.link()
        self.assertEqual(res["projects"]["conflicts"], [os.path.join("-p", "memory", "MEMORY.md")])
        self.assertLinked("projects")

    def test_history_bad_bytes_carried_unchanged(self):
        data = b'{"sessionId":"a","timestamp":1}\n\xff\xfe broken \x80\n'
        (self.profile / "history.jsonl").write_bytes(data)
        res = self.link()
        self.assertIsNone(res["history.jsonl"]["error"])
        shared = (self.shared / "history.jsonl").read_bytes()
        self.assertIn(b"\xff\xfe broken \x80\n", shared)
        [bk] = backups(self.profile, "history.jsonl")
        self.assertEqual(bk.read_bytes(), data)

    def test_unexpected_error_in_one_item(self):
        write(self.profile / "history.jsonl", "{}\n")
        write(self.profile / "plugins" / "a", "a")

        def boom(*a, **k):
            raise RuntimeError("boom")
        self.c._merge_history = boom
        res = self.link()
        self.assertIn("boom", res["history.jsonl"]["error"])
        self.assertIn("boom", self.out)
        self.assertTrue((self.profile / "history.jsonl").is_file())
        self.assertFalse((self.profile / "history.jsonl").is_symlink())
        self.assertLinked("plugins")
        self.assertLinked("settings.json")

    def test_migrate_continues_after_account_error(self):
        p2 = self.tmp / "profiles-test" / "second"
        p2.mkdir()
        acc = [{"name": "a", "config_path": str(self.profile)}, {"name": "b", "config_path": str(p2)}]
        self.c.ACCOUNTS.write_text(json.dumps({"accounts": acc}))
        real = self.c.setup_shared_links

        def flaky(path, **kw):
            if Path(path) == self.profile:
                raise RuntimeError("kaboom")
            return real(path, **kw)
        self.c.setup_shared_links = flaky
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.c.migrate()
        self.assertIn("kaboom", buf.getvalue())
        self.assertLinked("projects", p2)


class HistoryMergeTests(LinkingBase):
    """I4."""

    def merge(self, src_text, dst_text):
        src = write(self.tmp / "src.jsonl", src_text)
        dst = write(self.tmp / "dst.jsonl", dst_text)
        self.c._merge_history(src, dst)
        return dst.read_text()

    def test_missing_trailing_newline(self):
        out = self.merge('{"sessionId":"b","timestamp":2}\n', '{"sessionId":"a","timestamp":1}')
        self.assertEqual(out.splitlines(), ['{"sessionId":"a","timestamp":1}', '{"sessionId":"b","timestamp":2}'])

    def test_no_session_id_same_timestamp_kept(self):
        out = self.merge('{"display":"one","timestamp":7}\n{"display":"two","timestamp":7}\n', "")
        self.assertEqual(len(out.splitlines()), 2)

    def test_non_json_lines_carried_dedup_exact(self):
        out = self.merge("not json\nalso not\n", "not json\n")
        self.assertEqual(out.splitlines(), ["not json", "also not"])


class SettingsConflictTests(LinkingBase):
    """I5."""

    def test_settings_conflict_reported_by_key(self):
        write(self.shared / "settings.json", json.dumps({"same": 1, "hooks": {"a": "shared"}, "other": 3}))
        write(self.profile / "settings.json", json.dumps({"same": 1, "hooks": {"a": "SECRETVALUE"}, "mine": 2}))
        res = self.link()
        r = res["settings.json"]
        self.assertEqual(r["conflicts"], ["settings.json"])
        self.assertEqual(r["settings_keys"], ["hooks", "mine"])
        self.assertIn("no longer in effect", self.out)
        self.assertIn("hooks", self.out)
        self.assertIn("mine", self.out)
        self.assertNotIn("SECRETVALUE", self.out)
        self.assertIn(r["backup"], self.out)
        self.assertIn("SECRETVALUE", (self.shared / "settings.json").read_text() + Path(r["backup"]).read_text())
        self.assertNotIn("SECRETVALUE", (self.shared / "settings.json").read_text())

    def test_identical_settings_no_conflict(self):
        write(self.shared / "settings.json", '{"a": 1}')
        write(self.profile / "settings.json", '{"a":1}')
        res = self.link()
        self.assertEqual(res["settings.json"]["conflicts"], [])


class MinorTests(LinkingBase):
    def test_link_failure_restores_original(self):
        write(self.profile / "projects" / "-p" / "a.jsonl", "a")

        def fail(item, target):
            raise OSError(1, "nope")
        self.c._make_link = fail
        res = self.link()
        self.assertTrue((self.profile / "projects" / "-p" / "a.jsonl").is_file())
        self.assertEqual(backups(self.profile, "projects"), [])
        self.assertTrue(res["projects"]["error"])

    def test_link_and_restore_failure_prints_how_to_restore(self):
        write(self.profile / "projects" / "-p" / "a.jsonl", "a")
        calls = []
        real = self.c._rename

        def rename(a, b):
            calls.append((a, b))
            if len(calls) > 1:
                raise OSError(1, "nope")
            real(a, b)
        self.c._rename = rename

        def fail(item, target):
            raise OSError(1, "nope")
        self.c._make_link = fail
        self.link()
        [bk] = backups(self.profile, "projects")
        self.assertIn(str(bk), self.out)
        self.assertIn("mv ", self.out)

    def test_active_session_rechecked_before_rename(self):
        write(self.profile / "projects" / "-p" / "a.jsonl", "a")
        calls = []

        def active(path):
            calls.append(path)
            return len(calls) > 1
        self.c._has_active_sessions = active
        res = self.link()
        self.assertGreater(len(calls), 1)
        self.assertFalse((self.profile / "projects").is_symlink())
        self.assertEqual(backups(self.profile, "projects"), [])
        self.assertTrue(res["projects"]["error"])

    def test_empty_folders_recreated(self):
        (self.profile / "projects" / "-p" / "empty" / "deeper").mkdir(parents=True)
        self.link()
        self.assertTrue((self.shared / "projects" / "-p" / "empty" / "deeper").is_dir())

    def test_dir_file_mismatch_is_conflict(self):
        write(self.profile / "projects" / "x" / "inner.jsonl", "i")
        write(self.shared / "projects" / "x", "file in shared")
        write(self.profile / "projects" / "y", "file in profile")
        (self.shared / "projects" / "y").mkdir()
        res = self.link()
        self.assertEqual(sorted(res["projects"]["conflicts"]), ["x", "y"])
        self.assertIsNone(res["projects"]["error"])
        self.assertLinked("projects")

    def test_link_into_renames_real_folder(self):
        host = self.shared / ".plugin-host"
        write(host / "plugins" / "keep.txt", "k")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.c._link_into(host, "plugins", self.shared / "plugins")
        self.assertTrue((host / "plugins").is_symlink())
        [bk] = backups(host, "plugins")
        self.assertEqual((bk / "keep.txt").read_text(), "k")
        self.assertIn(str(bk), buf.getvalue())

    def test_help_mentions_dry_run(self):
        import subprocess
        r = subprocess.run([sys.executable, str(REPO / "claudes.py"), "nosuchcommand-xyz"],
                           env=dict(os.environ), capture_output=True, text=True, timeout=60)
        self.assertIn("migrate [--dry-run]", r.stdout)

    def test_dry_run_import_count_is_upper_bound(self):
        write(self.c.HOME / ".claudes" / "acc" / "projects" / "-q" / "a.jsonl", "a")
        self.c.ACCOUNTS.write_text(json.dumps({"accounts": [{"name": "acc", "config_path": str(self.profile)}]}))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.c.migrate(dry_run=True)
        self.assertIn("upper bound", buf.getvalue())


class SecondReviewTests(LinkingBase):
    # N1: a foreign link into or above shared is never merged.
    def overlap_case(self, link_target):
        write(self.shared / "projects" / "-s" / "keep.jsonl", "keep\n")
        before = snapshot(self.shared)
        os.symlink(link_target, self.profile / "cache")
        res = self.link()
        self.assertEqual(snapshot(self.shared), before)
        [bk] = backups(self.profile, "cache")
        self.assertEqual(os.readlink(bk), str(link_target))
        self.assertIn(str(link_target), self.out)
        self.assertIn("overlaps the shared layer", self.out)
        self.assertEqual(res["cache"]["copied"], 0)
        self.assertLinked("cache")

    def test_link_to_shared(self):
        self.overlap_case(self.shared)

    def test_link_to_base(self):
        self.overlap_case(self.c.BASE)

    def test_link_to_shared_grandparent(self):
        self.overlap_case(self.shared.parent.parent)

    def test_merge_tree_refuses_overlap(self):
        before = snapshot(self.shared)
        res = self.c._merge_tree(self.shared, self.shared / "cache")
        self.assertTrue(res["errors"])
        self.assertEqual(snapshot(self.shared), before)
        res = self.c._merge_tree(self.shared / "cache", self.shared)
        self.assertTrue(res["errors"])

    # N2
    def test_rename_back_skipped_when_original_reappears(self):
        write(self.profile / "projects" / "-p" / "a.jsonl", "a")

        def fail(item, target):
            write(Path(item) / "new.txt", "new")
            raise OSError(1, "nope")
        self.c._make_link = fail
        self.link()
        [bk] = backups(self.profile, "projects")
        self.assertEqual((bk / "-p" / "a.jsonl").read_text(), "a")
        self.assertEqual((self.profile / "projects" / "new.txt").read_text(), "new")
        self.assertFalse((self.profile / "projects" / "-p").exists())
        self.assertIn(str(bk), self.out)
        self.assertIn(str(self.profile / "projects"), self.out)
        self.assertNotIn("mv ", self.out)

    # N3
    def test_temp_name_short_and_unique(self):
        long_name = "x" * 240 + ".jsonl"
        write(self.profile / "projects" / "-p" / long_name, "data")
        seen = []
        real = self.c._copy_bytes

        def spy(fsrc, fdst):
            seen.append(os.path.basename(fdst.name))
            real(fsrc, fdst)
        self.c._copy_bytes = spy
        res = self.link()
        self.assertIsNone(res["projects"]["error"])
        self.assertEqual((self.shared / "projects" / "-p" / long_name).read_text(), "data")
        [name] = seen
        self.assertTrue(name.startswith(".claudes-") and name.endswith(".claudes-partial"))
        self.assertLess(len(name), 64)
        self.assertNotIn("xxxx", name)

    # N4
    def test_case_variant_of_shared_refused(self):
        inner = self.shared / "projects" / "-inner"
        inner.mkdir(parents=True)
        variant = self.shared.with_name("SHARED") / "projects" / "-inner"
        case_insensitive = variant.exists()
        before = snapshot(self.shared)
        res = self.link(variant if case_insensitive else inner)
        self.assertEqual(snapshot(self.shared), before)
        self.assertIn("refused", res["projects"]["error"])

    # N5a
    def test_settings_copied_through_shared_symlink(self):
        real = write(self.tmp / "real-settings.json", "{}")
        os.unlink(self.shared / "settings.json")
        os.symlink(real, self.shared / "settings.json")
        write(self.profile / "settings.json", '{"a":1}')
        self.link()
        self.assertTrue((self.shared / "settings.json").is_symlink())
        self.assertEqual(real.read_text(), '{"a":1}')

    # N5b
    def test_special_file_kept_only_in_backup(self):
        write(self.profile / "projects" / "-p" / "a.jsonl", "a")
        os.mkfifo(self.profile / "projects" / "-p" / "pipe")
        res = self.link()
        self.assertEqual(res["projects"]["special"], [os.path.join("-p", "pipe")])
        self.assertIsNone(res["projects"]["error"])
        self.assertIn("special file", self.out)
        self.assertFalse(os.path.lexists(self.shared / "projects" / "-p" / "pipe"))
        self.assertLinked("projects")
        [bk] = backups(self.profile, "projects")
        self.assertTrue(os.path.lexists(bk / "-p" / "pipe"))

    # N5c
    def test_memory_index_nothing_added_is_conflict(self):
        write(self.profile / "projects" / "-p" / "memory" / "MEMORY.md", "- [Other](a.md)\n")
        write(self.shared / "projects" / "-p" / "memory" / "MEMORY.md", "- [A](a.md)\n")
        res = self.link()
        self.assertEqual(res["projects"]["merged"], 0)
        self.assertEqual(res["projects"]["conflicts"], [os.path.join("-p", "memory", "MEMORY.md")])


if __name__ == "__main__":
    unittest.main()
