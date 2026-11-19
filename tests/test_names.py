import ast
import json
import os
import unittest
from pathlib import Path

from tests.helpers import REPO, load_claudes, write


def listing(root):
    out = []
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = Path(dp) / n
            out.append((str(p.relative_to(root)), p.is_symlink(), p.read_bytes() if p.is_file() and not p.is_symlink() else None))
    return sorted(out)


class Base(unittest.TestCase):
    def setUp(self):
        self.m, self.tmp = load_claudes(self)
        self.m.ensure()
        self.calls = []
        self.m._login = lambda n: self.calls.append(("login", n))
        self.m.setup_shared_links = lambda p: self.calls.append(("links", p))
        write(self.m.SHARED / "projects" / "keep.txt", "keep")
        self.m.CURRENT.write_text("")

    def seed(self, entries):
        self.m.ACCOUNTS.write_text(json.dumps({"accounts": [{"name": n, "config_path": str(p)} for n, p in entries]}))

    def names(self):
        return [a["name"] for a in json.loads(self.m.ACCOUNTS.read_text())["accounts"]]


class ValidName(Base):
    def test_accepts(self):
        for n in ["work", "sva-amresh", "Pranit", "a_1"]:
            self.assertIsNone(self.m.valid_account_name(n), n)

    def test_rejects(self):
        bad = ["", ".", "..", "../shared", "a/b", "-x", " work", "work ", "a b", "a\nb", "a" * 65] + sorted(self.m.RESERVED)
        for n in bad:
            self.assertIsInstance(self.m.valid_account_name(n), str, repr(n))
        self.assertIsNone(self.m.valid_account_name("a" * 64))


class Add(Base):
    def test_bad_names_change_nothing(self):
        for n in ["../shared", ".", "..", "a/b"]:
            before = listing(self.tmp)
            self.m.add(n)
            self.assertEqual(before, listing(self.tmp), n)
            self.assertEqual(self.names(), [])
            self.assertEqual(self.calls, [])
        self.assertTrue((self.m.SHARED / "projects" / "keep.txt").exists())

    def test_strict_child_guard_independent_of_regex(self):
        self.m.valid_account_name = lambda n: None
        for n in [".", "..", "../shared"]:
            before = listing(self.tmp)
            self.m.add(n)
            self.assertEqual(before, listing(self.tmp), n)
            self.assertEqual(self.calls, [])

    def test_good_name(self):
        self.m.add("work")
        self.assertTrue((self.m.PROFILES / "work").is_dir())
        self.assertEqual(self.names(), ["work"])
        self.assertEqual(self.calls, [("links", str(self.m.PROFILES / "work")), ("login", "work")])


class Rename(Base):
    def test_bad_new(self):
        self.seed([("work", self.m.PROFILES / "work")])
        before = listing(self.tmp)
        self.m.rename("work", "../x")
        self.assertEqual(before, listing(self.tmp))
        self.assertEqual(self.names(), ["work"])

    def test_good_new(self):
        self.seed([("work", self.m.PROFILES / "work")])
        self.m.rename("work", "home")
        self.assertEqual(self.names(), ["home"])

    def test_old_style_can_be_renamed(self):
        self.seed([("my.account", self.m.PROFILES / "my.account")])
        self.m.rename("my.account", "good")
        self.assertEqual(self.names(), ["good"])


class Remove(Base):
    def run_unsafe(self, target):
        write(target / "marker.txt", "m")
        before = listing(self.tmp)
        self.seed([("x", target)])
        self.m.remove("x", force=True)
        after = listing(self.tmp)
        self.assertTrue((target / "marker.txt").exists())
        self.assertTrue((self.m.SHARED / "projects" / "keep.txt").exists())
        self.assertEqual([r for r in before if "accounts.json" not in r[0]], [r for r in after if "accounts.json" not in r[0]])
        self.assertEqual(self.names(), [])

    def test_equals_profiles(self):
        self.run_unsafe(self.m.PROFILES)

    def test_equals_shared(self):
        self.run_unsafe(self.m.SHARED)

    def test_equals_base(self):
        self.run_unsafe(self.m.BASE)

    def test_parent_of_profiles(self):
        self.run_unsafe(self.m.BASE.parent)

    def test_outside_base(self):
        self.run_unsafe(self.tmp / "elsewhere")

    def test_dotdot_path_to_profiles(self):
        self.run_unsafe(self.m.PROFILES / "x" / "..")

    def test_normal(self):
        write(self.m.PROFILES / "a" / "f", "1")
        write(self.m.PROFILES / "b" / "f", "2")
        self.seed([("a", self.m.PROFILES / "a"), ("b", self.m.PROFILES / "b")])
        self.m.remove("a", force=True)
        self.assertFalse((self.m.PROFILES / "a").exists())
        self.assertTrue((self.m.PROFILES / "b" / "f").exists())
        self.assertEqual(self.names(), ["b"])

    def test_symlink_removes_link_only(self):
        target = self.tmp / "elsewhere"
        write(target / "data.txt", "d")
        link = self.m.PROFILES / "lnk"
        link.symlink_to(target)
        self.seed([("lnk", link)])
        self.m.remove("lnk", force=True)
        self.assertFalse(link.is_symlink())
        self.assertTrue((target / "data.txt").exists())
        self.assertEqual(self.names(), [])

    def test_symlink_to_shared(self):
        link = self.m.PROFILES / "lnk"
        link.symlink_to(self.m.SHARED)
        self.seed([("lnk", link)])
        self.m.remove("lnk", force=True)
        self.assertTrue((self.m.SHARED / "projects" / "keep.txt").exists())

    def test_old_style_name_removable(self):
        write(self.m.PROFILES / "my.account" / "f", "1")
        self.seed([("my.account", self.m.PROFILES / "my.account")])
        self.m.remove("my.account", force=True)
        self.assertFalse((self.m.PROFILES / "my.account").exists())
        self.assertEqual(self.names(), [])


class Imports(unittest.TestCase):
    def test_stdlib_only(self):
        import sys
        tree = ast.parse((REPO / "claudes.py").read_text())
        for node in ast.walk(tree):
            mods = []
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                mods = [node.module]
            for m in mods:
                self.assertIn(m.split(".")[0], sys.stdlib_module_names, m)


if __name__ == "__main__":
    unittest.main()
