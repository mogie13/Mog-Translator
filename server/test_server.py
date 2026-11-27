"""End-to-end tests over real HTTP.  Run from this folder: python3 -m unittest -v test_server"""
import base64
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

os.environ["MOG_PBKDF2_ROUNDS"] = "1000"   # fast hashing for tests only
sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402

PW = "correct horse"


class Client:
    def __init__(self, base):
        self.base, self.token = base, None

    def call(self, method, path, body=None, token=..., expect=None):
        tok = self.token if token is ... else token
        data = json.dumps(body).encode() if body is not None else (b"{}" if method == "POST" else None)
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        if tok:
            req.add_header("Authorization", "Bearer " + tok)
        try:
            with urllib.request.urlopen(req) as r:
                status, out = r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                status, out = e.code, json.loads(e.read())
        if expect is not None:
            assert status == expect, f"{method} {path}: expected {expect}, got {status} {out}"
        return status, out


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.dir.name, "t.db")
        self.store = server.Store(self.db)
        self.store.create_owner("Owner", PW)
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(server.Api(self.store), "*", False))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"
        self.owner = self.login("Owner")

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.dir.cleanup()

    # helpers
    def client(self):
        return Client(self.base)

    def login(self, name):
        c = self.client()
        _, out = c.call("POST", "/api/login", {"name": name, "password": PW}, expect=200)
        c.token, c.id = out["token"], out["user"]["id"]
        return c

    def signup(self, name, role=None):
        c = self.client()
        _, out = c.call("POST", "/api/signup", {"name": name, "password": PW}, expect=200)
        c.token, c.id = out["token"], out["user"]["id"]
        if role and role != "contributor":
            self.owner.call("POST", f"/api/users/{c.id}/role", {"role": role}, expect=200)
        return c

    def submit(self, c, mode="logged", mog="akong", token=...):
        _, out = c.call("POST", "/api/contributions", {"mode": mode, "mog": mog, "english": "water"}, token=token, expect=200)
        return out["id"]

    def rows(self, sql, *a):
        db = sqlite3.connect(self.db)
        db.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in db.execute(sql, a).fetchall()]
        finally:
            db.close()

    # ---------------------------------------------------------- the role rule (pure)
    def test_can_manage_matrix(self):
        U = lambda i, r, active=1: {"id": i, "role": r, "active": active}  # noqa: E731
        owner, admin, admin2, rev, con = U(1, "owner"), U(2, "admin"), U(3, "admin"), U(4, "reviewer"), U(5, "contributor")
        cm = server.can_manage
        # owner can change anyone but itself, into non-owner roles
        for t in (admin, rev, con):
            for r in ("admin", "reviewer", "contributor", None):
                self.assertTrue(cm(owner, t, r))
        self.assertFalse(cm(owner, owner, "admin"))
        self.assertFalse(cm(owner, con, "owner"))
        # admin: only reviewers/contributors, only into those roles
        self.assertTrue(cm(admin, rev, "contributor"))
        self.assertTrue(cm(admin, con, "reviewer"))
        self.assertTrue(cm(admin, con, None))
        self.assertFalse(cm(admin, con, "admin"))
        self.assertFalse(cm(admin, admin2, "contributor"))
        self.assertFalse(cm(admin, admin2, None))
        self.assertFalse(cm(admin, owner, "contributor"))
        self.assertFalse(cm(admin, admin, "reviewer"))
        # reviewers and contributors manage nobody; removed accounts can't act
        for actor in (rev, con):
            for t in (owner, admin, rev, con):
                self.assertFalse(cm(actor, t, "contributor"))
        self.assertFalse(cm(U(9, "owner", active=0), con, "reviewer"))

    # ---------------------------------------------------------- roles over HTTP
    def test_admin_limits_enforced_by_server(self):
        admin = self.signup("Ada", "admin")
        admin2 = self.signup("Bea", "admin")
        con = self.signup("Cal")
        admin.call("POST", f"/api/users/{con.id}/role", {"role": "reviewer"}, expect=200)
        admin.call("POST", f"/api/users/{con.id}/role", {"role": "admin"}, expect=403)
        admin.call("POST", f"/api/users/{admin2.id}/role", {"role": "contributor"}, expect=403)
        admin.call("POST", f"/api/users/{admin2.id}/remove", expect=403)
        admin.call("POST", f"/api/users/{self.owner.id}/role", {"role": "contributor"}, expect=403)
        admin.call("POST", f"/api/users/{self.owner.id}/remove", expect=403)
        admin.call("POST", f"/api/users/{admin.id}/role", {"role": "reviewer"}, expect=403)
        admin.call("POST", "/api/settings", {"open_signup": False}, expect=403)
        admin.call("POST", "/api/transfer-ownership", {"user_id": admin.id, "password": PW}, expect=403)
        self.assertEqual(self.rows("SELECT role FROM users WHERE id = ?", con.id)[0]["role"], "reviewer")

    def test_nobody_can_change_the_owner(self):
        self.owner.call("POST", f"/api/users/{self.owner.id}/role", {"role": "admin"}, expect=403)
        self.owner.call("POST", f"/api/users/{self.owner.id}/remove", expect=403)
        rev = self.signup("Rex", "reviewer")
        rev.call("POST", f"/api/users/{self.owner.id}/role", {"role": "contributor"}, expect=403)
        rev.call("GET", "/api/users", expect=403)
        # nobody can be made a second owner through role changes
        con = self.signup("Cy")
        self.owner.call("POST", f"/api/users/{con.id}/role", {"role": "owner"}, expect=403)
        self.assertEqual(len(self.rows("SELECT id FROM users WHERE role = 'owner'")), 1)

    def test_removed_user_loses_access(self):
        con = self.signup("Dee")
        self.owner.call("POST", f"/api/users/{con.id}/remove", expect=200)
        con.call("GET", "/api/me", expect=401)
        con.call("POST", "/api/login", {"name": "Dee", "password": PW}, token=None, expect=403)
        self.owner.call("POST", f"/api/users/{con.id}/restore", expect=200)
        self.login("Dee")

    def test_transfer_ownership(self):
        admin = self.signup("Eve", "admin")
        self.owner.call("POST", "/api/transfer-ownership", {"user_id": admin.id, "password": "wrong pw!"}, expect=403)
        self.owner.call("POST", "/api/transfer-ownership", {"user_id": admin.id, "password": PW}, expect=200)
        roles = {r["name"]: r["role"] for r in self.rows("SELECT name, role FROM users")}
        self.assertEqual(roles, {"Owner": "admin", "Eve": "owner"})
        # the new owner now has full control, including over the old owner
        admin.call("POST", f"/api/users/{self.owner.id}/role", {"role": "reviewer"}, expect=200)

    # ---------------------------------------------------------- contributions
    def test_review_flow_and_rejection_reason(self):
        con, rev, admin = self.signup("Fay"), self.signup("Gus", "reviewer"), self.signup("Hal", "admin")
        a, b = self.submit(con), self.submit(con, mog="nga2")
        rev.call("POST", f"/api/contributions/{a}/approve", expect=200)
        rev.call("POST", f"/api/contributions/{b}/reject", {}, expect=400)          # reason required
        rev.call("POST", f"/api/contributions/{b}/reject", {"reason": "Wrong tone"}, expect=200)
        rev.call("POST", f"/api/contributions/{a}/publish", expect=403)             # reviewers don't publish
        self.client().call("GET", "/api/entries", expect=200)
        self.assertEqual(self.client().call("GET", "/api/entries")[1]["entries"], [])
        admin.call("POST", f"/api/contributions/{a}/publish", expect=200)
        pub = self.client().call("GET", "/api/entries")[1]["entries"]
        self.assertEqual([e["mog"] for e in pub], ["akong"])
        self.assertNotIn("submitted_by", pub[0])
        mine = {i["id"]: i for i in con.call("GET", "/api/contributions/mine")[1]["items"]}
        self.assertEqual(mine[a]["status"], "published")
        self.assertEqual((mine[b]["status"], mine[b]["reject_reason"]), ("rejected", "Wrong tone"))
        # edit and unpublish are admin/owner only and audited
        rev.call("POST", f"/api/contributions/{a}/edit", {"english": "drinking water"}, expect=403)
        admin.call("POST", f"/api/contributions/{a}/edit", {"english": "drinking water"}, expect=200)
        admin.call("POST", f"/api/contributions/{a}/unpublish", expect=200)
        self.assertEqual(self.client().call("GET", "/api/entries")[1]["entries"], [])
        actions = [r["action"] for r in self.rows("SELECT action FROM audit_log ORDER BY id")]
        self.assertEqual(actions, ["role_change", "role_change", "approve", "reject", "publish", "edit", "unpublish"])

    def test_cannot_review_own_logged_submission(self):
        rev = self.signup("Ivy", "reviewer")
        cid = self.submit(rev)
        rev.call("POST", f"/api/contributions/{cid}/approve", expect=403)
        rev.call("GET", "/api/contributions?status=approved", expect=403)   # reviewers: pending queue only
        self.owner.call("POST", f"/api/contributions/{cid}/approve", expect=200)

    def test_unlogged_stores_no_contributor_even_when_signed_in(self):
        con = self.signup("Jo")
        # the signed-in token is sent on purpose; the server must ignore it
        cid = self.submit(con, mode="unlogged")
        row = self.rows("SELECT * FROM contributions WHERE id = ?", cid)[0]
        self.assertIsNone(row["submitted_by"])
        self.assertEqual(row["mode"], "unlogged")
        self.assertTrue(row["created_at"].endswith("T00:00:00+00:00"))        # day only
        self.assertEqual(con.call("GET", "/api/contributions/mine")[1]["items"], [])
        queue = self.owner.call("GET", "/api/contributions")[1]["items"]
        self.assertIsNone(queue[0]["submitted_by_name"])
        # and the database refuses an unlogged row with an ID
        db = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("INSERT INTO contributions (mog, mode, submitted_by, created_at, updated_at) VALUES ('x','unlogged',?, 'd','d')", (con.id,))
        db.close()

    def test_unlogged_review_is_still_audited(self):
        cid = self.submit(self.client(), mode="unlogged", token=None)
        self.owner.call("POST", f"/api/contributions/{cid}/reject", {"reason": "spam"}, expect=200)
        log = self.owner.call("GET", "/api/audit")[1]["items"]
        self.assertEqual((log[0]["action"], log[0]["actor_name"], log[0]["target"]), ("reject", "Owner", f"contribution:{cid}"))
        self.assertNotIn("submitted", json.dumps(log[0]["details"]))

    def test_logged_requires_sign_in(self):
        self.client().call("POST", "/api/contributions", {"mode": "logged", "mog": "a", "english": "b"}, expect=401)

    def test_owner_settings(self):
        self.owner.call("POST", "/api/settings", {"allow_unlogged": False}, expect=200)
        self.client().call("POST", "/api/contributions", {"mode": "unlogged", "mog": "a", "english": "b"}, expect=403)
        self.owner.call("POST", "/api/settings", {"open_signup": False}, expect=200)
        self.client().call("POST", "/api/signup", {"name": "Kit", "password": PW}, expect=403)
        self.assertEqual(self.client().call("GET", "/api/settings")[1], {"allow_unlogged": False, "open_signup": False})

    def test_audit_log_is_append_only(self):
        con = self.signup("Lu")
        self.owner.call("POST", f"/api/users/{con.id}/role", {"role": "reviewer"}, expect=200)
        db = sqlite3.connect(self.db)
        for sql in ("UPDATE audit_log SET action = 'x'", "DELETE FROM audit_log"):
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute(sql)
        db.close()
        con.call("GET", "/api/audit", expect=403)

    def test_one_owner_at_database_level(self):
        with self.assertRaises(server.ApiError):
            self.store.create_owner("Other", PW)
        db = sqlite3.connect(self.db)
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("UPDATE users SET role = 'owner' WHERE name != 'Owner'") if self.rows("SELECT 1 FROM users WHERE name != 'Owner'") else db.execute(
                "INSERT INTO users (name, role, created_at, password_hash) VALUES ('X','owner','d','h')")
        db.close()

    def test_bad_login_and_input(self):
        self.client().call("POST", "/api/login", {"name": "Owner", "password": "nope nope"}, expect=401)
        self.client().call("POST", "/api/signup", {"name": "A", "password": PW}, expect=400)
        self.client().call("POST", "/api/signup", {"name": "Mo", "password": "short"}, expect=400)
        self.client().call("POST", "/api/contributions", {"mode": "unlogged", "mog": "x" * 500, "english": "b"}, expect=400)
        self.client().call("GET", "/api/nope", expect=404)


    # ---------------------------------------------------------- recordings
    WEBM = b"\x1a\x45\xdf\xa3" + b"fake opus audio " * 50

    def send_audio(self, c, mode="logged", consent=True, data=None, token=..., expect=200):
        body = {"mode": mode, "kind": "audio", "mog": "akong", "target": "e1", "consent": consent,
                "audio": {"type": "audio/webm;codecs=opus", "data": base64.b64encode(data or self.WEBM).decode()}}
        return c.call("POST", "/api/contributions", body, token=token, expect=expect)[1]

    def get_audio(self, cid, token=None, headers=None):
        req = urllib.request.Request(f"{self.base}/api/audio/{cid}", headers=headers or {})
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read(), dict(e.headers)

    def test_recording_needs_consent_and_real_audio(self):
        con = self.signup("Mia")
        self.send_audio(con, consent=False, expect=400)
        self.send_audio(con, data=b"<html>not audio</html>", expect=400)
        con.call("POST", "/api/contributions", {"mode": "logged", "kind": "audio", "mog": "akong"}, expect=400)
        out = self.send_audio(con)
        self.assertTrue(out["has_audio"])
        row = self.rows("SELECT mime, bytes FROM audio WHERE contribution_id = ?", out["id"])[0]
        self.assertEqual(row, {"mime": "audio/webm", "bytes": len(self.WEBM)})   # type from the bytes, not the claim

    def test_who_can_hear_a_recording(self):
        con, other, rev = self.signup("Ned"), self.signup("Oli"), self.signup("Pam", "reviewer")
        cid = self.send_audio(con)["id"]
        self.assertEqual(self.get_audio(cid)[0], 404)                     # public: not before publishing
        self.assertEqual(self.get_audio(cid, other.token)[0], 404)        # another contributor
        self.assertEqual(self.get_audio(cid, con.token)[0], 200)          # the sender
        status, data, _ = self.get_audio(cid, rev.token)                  # a reviewer
        self.assertEqual((status, data), (200, self.WEBM))
        self.owner.call("POST", f"/api/contributions/{cid}/approve", expect=200)
        self.owner.call("POST", f"/api/contributions/{cid}/publish", expect=200)
        status, data, h = self.get_audio(cid)
        self.assertEqual((status, h["Content-Type"]), (200, "audio/webm"))
        pub = self.client().call("GET", "/api/entries")[1]["entries"][0]
        self.assertEqual((pub["has_audio"], pub["target"], pub["kind"]), (True, "e1", "audio"))
        # iPhones fetch media in byte ranges
        status, part, h = self.get_audio(cid, headers={"Range": "bytes=0-9"})
        self.assertEqual((status, part, h["Content-Range"]), (206, self.WEBM[:10], f"bytes 0-9/{len(self.WEBM)}"))

    def test_unlogged_recording_has_no_owner(self):
        con = self.signup("Quin")
        cid = self.send_audio(con, mode="unlogged")["id"]
        self.assertIsNone(self.rows("SELECT submitted_by FROM contributions WHERE id = ?", cid)[0]["submitted_by"])
        self.assertEqual(self.get_audio(cid, con.token)[0], 404)          # nobody can prove it was theirs

    def test_admin_can_remove_a_recording_and_it_is_audited(self):
        cid = self.send_audio(self.signup("Ray"))["id"]
        self.owner.call("POST", f"/api/contributions/{cid}/approve", expect=200)
        self.owner.call("POST", f"/api/contributions/{cid}/edit", {"remove_audio": True}, expect=200)
        self.assertEqual(self.rows("SELECT COUNT(*) AS n FROM audio")[0]["n"], 0)
        self.assertEqual(self.rows("SELECT action, details FROM audit_log ORDER BY id DESC LIMIT 1")[0]["action"], "edit")

    def test_old_database_is_upgraded_in_place(self):
        old = os.path.join(self.dir.name, "old.db")
        db = sqlite3.connect(old)
        db.executescript("""CREATE TABLE contributions (id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'word', mog TEXT NOT NULL,
            bengali TEXT NOT NULL DEFAULT '', english TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending', mode TEXT NOT NULL, submitted_by INTEGER, reviewed_by INTEGER, reject_reason TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            INSERT INTO contributions (mog, mode, created_at, updated_at) VALUES ('hli2', 'unlogged', 'd', 'd');""")
        db.commit(); db.close()
        server.Store(old)
        db = sqlite3.connect(old)
        cols = {r[1] for r in db.execute("PRAGMA table_info(contributions)")}
        self.assertTrue({"target", "speaker", "consent"} <= cols)
        self.assertEqual(db.execute("SELECT mog FROM contributions").fetchone()[0], "hli2")   # data kept
        db.close()


if __name__ == "__main__":
    unittest.main()
