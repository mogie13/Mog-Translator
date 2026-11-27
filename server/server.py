#!/usr/bin/env python3
"""Mog Translator contribution server.

Accounts, roles, the review queue and the audit log. Python 3.10+ standard library
only (sqlite3 + http.server), so it runs on any small host.

    python3 server.py init-owner --name YOURNAME      # once: create the owner account
    python3 server.py serve --port 8787               # run the API

Rules this file enforces (the app's buttons are only hints; every check is here):
  * Roles: owner > admin > reviewer > contributor. Exactly one owner.
  * Owner: can change anyone except itself; only owner appoints/removes admins,
    changes settings or transfers ownership.
  * Admin: can change reviewers and contributors only, and only to reviewer/contributor.
  * Nobody can change, remove or demote the owner (only the owner's own transfer).
  * Unlogged contributions store no contributor ID and the request's login is ignored.
  * Every admin action (role change, approve, reject, edit, publish, unpublish,
    settings, transfer) is written to an append-only audit log.
  * Recordings are stored in the same database (table `audio`), need the speaker's
    consent, and are only served to the public once their suggestion is published.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROLES = ("owner", "admin", "reviewer", "contributor")
STAFF = ("owner", "admin")                        # edit, publish, unpublish, users, audit
REVIEWERS = ("owner", "admin", "reviewer")        # approve, reject
STATUSES = ("pending", "approved", "rejected", "published")
KINDS = ("word", "phrase", "correction", "audio")
LIMITS = {"mog": 200, "bengali": 300, "english": 300, "note": 1000, "category": 40, "reason": 500,
          "speaker": 80, "target": 40}
SESSION_DAYS = 30
MAX_BODY = 3 * 1024 * 1024          # room for one base64 recording
AUDIO_MAX = 2 * 1024 * 1024         # decoded; a 10-second clip is usually 20–200 KB
PBKDF2_ROUNDS = int(os.environ.get("MOG_PBKDF2_ROUNDS", "600000"))

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','reviewer','contributor')),
  appointed_by  INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1
);
-- at most one owner, enforced by the database itself
CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON users(role) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contributions (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'word',
  mog           TEXT NOT NULL,
  bengali       TEXT NOT NULL DEFAULT '',
  english       TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','published')),
  mode          TEXT NOT NULL CHECK (mode IN ('logged','unlogged')),
  submitted_by  INTEGER REFERENCES users(id),
  reviewed_by   INTEGER REFERENCES users(id),
  reject_reason TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- an unlogged row can never carry a contributor ID
  CHECK ((mode = 'logged' AND submitted_by IS NOT NULL) OR (mode = 'unlogged' AND submitted_by IS NULL))
);
CREATE INDEX IF NOT EXISTS contributions_status ON contributions(status);
CREATE INDEX IF NOT EXISTS contributions_by ON contributions(submitted_by);

-- one recording per contribution, kept in the database so a single file holds everything
CREATE TABLE IF NOT EXISTS audio (
  contribution_id INTEGER PRIMARY KEY REFERENCES contributions(id) ON DELETE CASCADE,
  mime            TEXT NOT NULL,
  data            BLOB NOT NULL,
  bytes           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
-- append-only: nobody, not even the owner through the API, can rewrite history
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('allow_unlogged', '1');
INSERT OR IGNORE INTO settings VALUES ('open_signup', '1');
"""
SETTING_KEYS = ("allow_unlogged", "open_signup")


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today() -> str:
    # unlogged rows keep only the day, so timing can't be matched against other activity
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")


# ---------------------------------------------------------------- passwords and tokens

def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, rounds, salt, want = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(dk.hex(), want)
    except (ValueError, TypeError):
        return False


def token_hash(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


# ---------------------------------------------------------------- the role rule

def can_manage(actor: dict | None, target: dict | None, new_role: str | None = None) -> bool:
    """Can `actor` change `target`'s role to `new_role` (or remove/restore them if None)?

    The owner can change anyone; an admin only reviewers and contributors (and only
    into those roles); nobody can change the owner or themselves. Ownership moves
    only through transfer_ownership().
    """
    if not actor or not target or not actor["active"]:
        return False
    if target["role"] == "owner" or actor["id"] == target["id"]:
        return False
    if new_role is not None and new_role not in ("admin", "reviewer", "contributor"):
        return False
    if actor["role"] == "owner":
        return True
    if actor["role"] == "admin":
        return target["role"] in ("reviewer", "contributor") and new_role in (None, "reviewer", "contributor")
    return False


def assignable_roles(actor: dict | None) -> list[str]:
    if actor and actor["role"] == "owner":
        return ["admin", "reviewer", "contributor"]
    if actor and actor["role"] == "admin":
        return ["reviewer", "contributor"]
    return []


# ---------------------------------------------------------------- store

class Store:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()   # one writer at a time; plenty for a community dictionary
        with self.connect() as db:
            db.executescript(SCHEMA)
            cols = {r["name"] for r in db.execute("PRAGMA table_info(contributions)")}
            for col, ddl in (("target", "TEXT NOT NULL DEFAULT ''"), ("speaker", "TEXT NOT NULL DEFAULT ''"),
                             ("consent", "INTEGER NOT NULL DEFAULT 0")):
                if col not in cols:   # older databases: add the column, keep the data
                    db.execute(f"ALTER TABLE contributions ADD COLUMN {col} {ddl}")

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA journal_mode = WAL")
        return db

    # -- helpers used by the API
    @staticmethod
    def user(db, uid) -> dict | None:
        r = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        return dict(r) if r else None

    @staticmethod
    def setting(db, key) -> bool:
        r = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return bool(r and r["value"] == "1")

    @staticmethod
    def audit(db, actor_id: int, action: str, target: str, details: dict | None = None):
        db.execute("INSERT INTO audit_log (actor_id, action, target, details, created_at) VALUES (?,?,?,?,?)",
                   (actor_id, action, target, json.dumps(details or {}, ensure_ascii=False), now()))

    def create_owner(self, name: str, password: str) -> int:
        with self.connect() as db:
            if db.execute("SELECT 1 FROM users WHERE role = 'owner'").fetchone():
                raise ApiError(409, "An owner already exists. Use transfer ownership instead.")
            validate_name(name)
            validate_password(password)
            cur = db.execute("INSERT INTO users (name, role, appointed_by, created_at, password_hash) VALUES (?,?,?,?,?)",
                             (name, "owner", None, now(), hash_password(password)))
            return cur.lastrowid


def validate_name(name: str):
    if not isinstance(name, str) or not re.fullmatch(r"[\w .\-]{2,40}", name.strip(), re.UNICODE):
        raise ApiError(400, "Name must be 2–40 letters, numbers, spaces, dots or dashes.")


def validate_password(pw: str):
    if not isinstance(pw, str) or len(pw) < 8 or len(pw) > 200:
        raise ApiError(400, "Password must be at least 8 characters.")


def clean(body: dict, key: str, required=False) -> str:
    v = body.get(key, "")
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise ApiError(400, f"{key} must be text.")
    v = v.strip()
    if required and not v:
        raise ApiError(400, f"{key} is required.")
    if len(v) > LIMITS.get(key, 200):
        raise ApiError(400, f"{key} is too long.")
    return v


def sniff_audio(data: bytes) -> str | None:
    """The file's real type from its first bytes; the browser's claim isn't trusted."""
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0):
        return "audio/mpeg"
    return None


def decode_audio(v) -> tuple[str, bytes] | None:
    if v in (None, ""):
        return None
    if not isinstance(v, dict) or not isinstance(v.get("data"), str):
        raise ApiError(400, "Recording must be sent as {type, data}.")
    try:
        data = base64.b64decode(v["data"], validate=True)
    except (binascii.Error, ValueError):
        raise ApiError(400, "Recording is damaged.")
    if not data:
        raise ApiError(400, "Recording is empty.")
    if len(data) > AUDIO_MAX:
        raise ApiError(413, "Recording is too long. Keep it under about 10 seconds.")
    mime = sniff_audio(data)
    if not mime:
        raise ApiError(400, "That isn't a recording this app understands.")
    return mime, data


class Raw:
    """A binary response (a recording) instead of JSON."""

    def __init__(self, mime: str, data: bytes, public: bool):
        self.mime, self.data, self.public = mime, data, public


# ---------------------------------------------------------------- simple in-memory rate limits

class RateLimit:
    """Counts per key in a sliding window. Keys (e.g. IP addresses) live only in memory
    for the window and are never written to disk or logs."""

    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self.hits: dict[str, list[float]] = {}
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        t = time.monotonic()
        with self.lock:
            q = [x for x in self.hits.get(key, []) if t - x < self.window]
            if len(q) >= self.limit:
                self.hits[key] = q
                return False
            q.append(t)
            self.hits[key] = q
            if len(self.hits) > 10000:   # keep memory bounded
                self.hits = {k: v for k, v in self.hits.items() if v and t - v[-1] < self.window}
            return True


# ---------------------------------------------------------------- API

def public_user(u: dict) -> dict:
    return {"id": u["id"], "name": u["name"], "role": u["role"], "appointed_by": u["appointed_by"],
            "created_at": u["created_at"], "active": bool(u["active"])}


def row_out(r: sqlite3.Row, show_submitter: bool) -> dict:
    d = {k: r[k] for k in ("id", "kind", "mog", "bengali", "english", "category", "note", "status", "mode",
                           "reject_reason", "created_at", "updated_at", "target", "speaker")}
    d["has_audio"] = bool(r["audio_bytes"])
    if show_submitter:
        d["submitted_by_name"] = r["submitter_name"] if r["mode"] == "logged" else None
        d["reviewed_by_name"] = r["reviewer_name"]
    return d


CONTRIB_SELECT = """SELECT c.*, su.name AS submitter_name, ru.name AS reviewer_name,
  (SELECT bytes FROM audio a WHERE a.contribution_id = c.id) AS audio_bytes
  FROM contributions c LEFT JOIN users su ON su.id = c.submitted_by LEFT JOIN users ru ON ru.id = c.reviewed_by"""


class Api:
    def __init__(self, store: Store):
        self.store = store
        self.login_limit = RateLimit(10, 15 * 60)       # per name
        self.signup_limit = RateLimit(5, 60 * 60)       # per client address
        self.unlogged_limit = RateLimit(30, 60 * 60)    # per client address

    # route table: (method, regex) -> handler(db, me, body, match, query, client)
    def routes(self):
        return [
            ("GET", r"/api/health", self.health),
            ("GET", r"/api/settings", self.get_settings),
            ("POST", r"/api/settings", self.set_settings),
            ("POST", r"/api/signup", self.signup),
            ("POST", r"/api/login", self.login),
            ("POST", r"/api/logout", self.logout),
            ("GET", r"/api/me", self.me),
            ("POST", r"/api/me/password", self.change_password),
            ("GET", r"/api/entries", self.entries),
            ("POST", r"/api/contributions", self.submit),
            ("GET", r"/api/contributions/mine", self.mine),
            ("GET", r"/api/contributions", self.queue),
            ("POST", r"/api/contributions/(\d+)/approve", self.approve),
            ("POST", r"/api/contributions/(\d+)/reject", self.reject),
            ("POST", r"/api/contributions/(\d+)/publish", self.publish),
            ("POST", r"/api/contributions/(\d+)/unpublish", self.unpublish),
            ("POST", r"/api/contributions/(\d+)/edit", self.edit),
            ("GET", r"/api/audio/(\d+)", self.audio),
            ("GET", r"/api/users", self.users),
            ("POST", r"/api/users/(\d+)/role", self.set_role),
            ("POST", r"/api/users/(\d+)/remove", self.remove_user),
            ("POST", r"/api/users/(\d+)/restore", self.restore_user),
            ("POST", r"/api/transfer-ownership", self.transfer),
            ("GET", r"/api/audit", self.audit_log),
        ]

    # -- auth helpers
    def current_user(self, db, auth_header: str | None) -> dict | None:
        if not auth_header or not auth_header.startswith("Bearer "):
            return None
        r = db.execute("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
                       (token_hash(auth_header[7:].strip()), int(time.time()))).fetchone()
        if not r or not r["active"]:
            return None
        me = dict(r)
        me["_tok_hash"] = token_hash(auth_header[7:].strip())
        return me

    @staticmethod
    def need(me, roles=None) -> dict:
        if not me:
            raise ApiError(401, "Please sign in.")
        if roles and me["role"] not in roles:
            raise ApiError(403, "Your role can't do that.")
        return me

    @staticmethod
    def new_session(db, uid: int) -> str:
        tok = secrets.token_urlsafe(32)
        db.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
        db.execute("INSERT INTO sessions VALUES (?,?,?)", (token_hash(tok), uid, int(time.time()) + SESSION_DAYS * 86400))
        return tok

    def me_payload(self, me: dict) -> dict:
        return {"user": public_user(me), "can": {
            "review": me["role"] in REVIEWERS,
            "edit": me["role"] in STAFF,
            "manage_users": me["role"] in STAFF,
            "assign_roles": assignable_roles(me),
            "settings": me["role"] == "owner",
            "transfer": me["role"] == "owner",
            "audit": me["role"] in STAFF,
        }}

    # -- public
    def health(self, db, me, body, m, q, client):
        return {"ok": True}

    def get_settings(self, db, me, body, m, q, client):
        return {k: self.store.setting(db, k) for k in SETTING_KEYS}

    def entries(self, db, me, body, m, q, client):
        rows = db.execute("""SELECT c.id, c.kind, c.mog, c.bengali, c.english, c.category, c.target, c.speaker, c.updated_at,
                                    EXISTS (SELECT 1 FROM audio a WHERE a.contribution_id = c.id) AS has_audio
                             FROM contributions c WHERE c.status = 'published' ORDER BY c.id""").fetchall()
        return {"entries": [{**dict(r), "has_audio": bool(r["has_audio"])} for r in rows]}

    # -- accounts
    def signup(self, db, me, body, m, q, client):
        if not self.store.setting(db, "open_signup"):
            raise ApiError(403, "New accounts are closed. Ask an admin.")
        if not self.signup_limit.allow(client):
            raise ApiError(429, "Too many new accounts from here. Try again later.")
        name = body.get("name", "")
        validate_name(name)
        validate_password(body.get("password"))
        name = name.strip()
        if db.execute("SELECT 1 FROM users WHERE name = ?", (name,)).fetchone():
            raise ApiError(409, "That name is taken.")
        cur = db.execute("INSERT INTO users (name, role, appointed_by, created_at, password_hash) VALUES (?,?,?,?,?)",
                         (name, "contributor", None, now(), hash_password(body["password"])))
        me = self.store.user(db, cur.lastrowid)
        return {"token": self.new_session(db, me["id"]), **self.me_payload(me)}

    def login(self, db, me, body, m, q, client):
        name = str(body.get("name", "")).strip()
        if not self.login_limit.allow(name.lower()):
            raise ApiError(429, "Too many attempts. Wait 15 minutes.")
        r = db.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchone()
        if not r or not check_password(str(body.get("password", "")), r["password_hash"]):
            raise ApiError(401, "Wrong name or password.")
        if not r["active"]:
            raise ApiError(403, "This account has been removed.")
        return {"token": self.new_session(db, r["id"]), **self.me_payload(dict(r))}

    def logout(self, db, me, body, m, q, client):
        if me:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (me["_tok_hash"],))
        return {"ok": True}

    def me(self, db, me, body, m, q, client):
        return self.me_payload(self.need(me))

    def change_password(self, db, me, body, m, q, client):
        me = self.need(me)
        if not check_password(str(body.get("current", "")), me["password_hash"]):
            raise ApiError(403, "Current password is wrong.")
        validate_password(body.get("new"))
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(body["new"]), me["id"]))
        db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (me["id"], me["_tok_hash"]))
        return {"ok": True}

    # -- contributions
    def submit(self, db, me, body, m, q, client):
        mode = body.get("mode")
        if mode not in ("logged", "unlogged"):
            raise ApiError(400, "Choose logged or unlogged.")
        kind = body.get("kind", "word")
        if kind not in KINDS:
            raise ApiError(400, "Unknown kind.")
        fields = dict(mog=clean(body, "mog", required=True), bengali=clean(body, "bengali"), english=clean(body, "english"),
                      category=clean(body, "category"), note=clean(body, "note"), target=clean(body, "target"),
                      speaker=clean(body, "speaker"))
        audio = decode_audio(body.get("audio"))
        if kind == "audio" and not audio:
            raise ApiError(400, "Record the pronunciation first.")
        if audio and body.get("consent") is not True:
            raise ApiError(400, "The speaker has to agree before a recording is sent.")
        if not fields["bengali"] and not fields["english"] and kind not in ("correction", "audio"):
            raise ApiError(400, "Add a Bengali or English meaning.")
        if mode == "logged":
            me = self.need(me)
            submitted_by, created = me["id"], now()
        else:
            # The login (if any) is deliberately ignored: nothing ties this row to a person.
            if not self.store.setting(db, "allow_unlogged"):
                raise ApiError(403, "Anonymous suggestions are turned off. Sign in to send.")
            if not self.unlogged_limit.allow(client):
                raise ApiError(429, "Too many anonymous suggestions from here. Try again later.")
            submitted_by, created = None, today()
        cur = db.execute("""INSERT INTO contributions (kind, mog, bengali, english, category, note, target, speaker, consent,
                                                       status, mode, submitted_by, created_at, updated_at)
                            VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?,?,?,?)""",
                         (kind, *fields.values(), 1 if audio else 0, mode, submitted_by, created, created))
        if audio:
            db.execute("INSERT INTO audio VALUES (?,?,?,?)", (cur.lastrowid, audio[0], audio[1], len(audio[1])))
        return {"id": cur.lastrowid, "status": "pending", "mode": mode, "has_audio": bool(audio)}

    def audio(self, db, me, body, m, q, client):
        """Published recordings are public. Before that only reviewers, admins, the owner
        and (for logged suggestions) the person who sent it can listen."""
        r = db.execute("""SELECT c.status, c.mode, c.submitted_by, a.mime, a.data FROM audio a
                          JOIN contributions c ON c.id = a.contribution_id WHERE a.contribution_id = ?""", (int(m.group(1)),)).fetchone()
        if not r:
            raise ApiError(404, "No recording.")
        public = r["status"] == "published"
        if not public:
            own = me and r["mode"] == "logged" and r["submitted_by"] == me["id"]
            if not (own or (me and me["role"] in REVIEWERS)):
                raise ApiError(404, "No recording.")   # don't reveal that unpublished items exist
        return Raw(r["mime"], bytes(r["data"]), public)

    def mine(self, db, me, body, m, q, client):
        me = self.need(me)
        rows = db.execute(CONTRIB_SELECT + " WHERE c.submitted_by = ? AND c.mode = 'logged' ORDER BY c.id DESC", (me["id"],)).fetchall()
        return {"items": [row_out(r, False) for r in rows]}

    def queue(self, db, me, body, m, q, client):
        me = self.need(me, REVIEWERS)
        status = (q.get("status") or ["pending"])[0]
        if status not in STATUSES:
            raise ApiError(400, "Unknown status.")
        if status != "pending" and me["role"] not in STAFF:
            raise ApiError(403, "Reviewers see the pending queue only.")
        rows = db.execute(CONTRIB_SELECT + " WHERE c.status = ? ORDER BY c.id DESC LIMIT 500", (status,)).fetchall()
        return {"items": [row_out(r, True) for r in rows]}

    def _contribution(self, db, cid) -> sqlite3.Row:
        r = db.execute("SELECT * FROM contributions WHERE id = ?", (int(cid),)).fetchone()
        if not r:
            raise ApiError(404, "No such contribution.")
        return r

    def _move(self, db, me, cid, frm: str, to: str, action: str, roles, reason=None):
        """One status step. `action` is the audit-log verb (approve, reject, publish, unpublish)."""
        me = self.need(me, roles)
        c = self._contribution(db, cid)
        if c["status"] != frm:
            raise ApiError(409, f"It is {c['status']}, so you can't {action} it.")
        if action in ("approve", "reject"):
            if c["submitted_by"] == me["id"]:
                raise ApiError(403, "Someone else has to review your own suggestion.")
            db.execute("UPDATE contributions SET status = ?, reviewed_by = ?, reject_reason = ?, updated_at = ? WHERE id = ?",
                       (to, me["id"], reason, now(), c["id"]))
        else:
            db.execute("UPDATE contributions SET status = ?, updated_at = ? WHERE id = ?", (to, now(), c["id"]))
        details = {"from": c["status"], "to": to}
        if reason:
            details["reason"] = reason
        self.store.audit(db, me["id"], action, f"contribution:{c['id']}", details)
        return {"id": c["id"], "status": to}

    def approve(self, db, me, body, m, q, client):
        return self._move(db, me, m.group(1), "pending", "approved", "approve", REVIEWERS)

    def reject(self, db, me, body, m, q, client):
        reason = clean(body, "reason", required=True)
        return self._move(db, me, m.group(1), "pending", "rejected", "reject", REVIEWERS, reason=reason)

    def publish(self, db, me, body, m, q, client):
        return self._move(db, me, m.group(1), "approved", "published", "publish", STAFF)

    def unpublish(self, db, me, body, m, q, client):
        return self._move(db, me, m.group(1), "published", "approved", "unpublish", STAFF)

    def edit(self, db, me, body, m, q, client):
        me = self.need(me, STAFF)
        c = self._contribution(db, m.group(1))
        if c["status"] not in ("approved", "published"):
            raise ApiError(409, "Only approved or published items can be edited.")
        changes = {}
        for k in ("mog", "bengali", "english", "category", "note", "speaker"):
            if k in body:
                v = clean(body, k, required=(k == "mog"))
                if v != c[k]:
                    changes[k] = {"from": c[k], "to": v}
        if "kind" in body and body["kind"] != c["kind"]:
            if body["kind"] not in KINDS:
                raise ApiError(400, "Unknown kind.")
            changes["kind"] = {"from": c["kind"], "to": body["kind"]}
        remove_audio = body.get("remove_audio") is True and db.execute(
            "SELECT 1 FROM audio WHERE contribution_id = ?", (c["id"],)).fetchone() is not None
        if not changes and not remove_audio:
            return {"id": c["id"], "changed": []}
        if changes:
            sets = ", ".join(f"{k} = ?" for k in changes)
            db.execute(f"UPDATE contributions SET {sets}, updated_at = ? WHERE id = ?",
                       (*[v["to"] for v in changes.values()], now(), c["id"]))
        if remove_audio:
            db.execute("DELETE FROM audio WHERE contribution_id = ?", (c["id"],))
            db.execute("UPDATE contributions SET updated_at = ? WHERE id = ?", (now(), c["id"]))
            changes["recording"] = {"from": "kept", "to": "removed"}
        self.store.audit(db, me["id"], "edit", f"contribution:{c['id']}", changes)
        return {"id": c["id"], "changed": list(changes)}

    # -- users and roles
    def users(self, db, me, body, m, q, client):
        me = self.need(me, STAFF)
        rows = db.execute("SELECT * FROM users ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'reviewer' THEN 2 ELSE 3 END, name").fetchall()
        out = []
        for r in rows:
            u = public_user(dict(r))
            u["can_change"] = can_manage(me, dict(r))
            out.append(u)
        return {"users": out, "assign_roles": assignable_roles(me)}

    def _target(self, db, uid) -> dict:
        t = self.store.user(db, int(uid))
        if not t:
            raise ApiError(404, "No such user.")
        return t

    def set_role(self, db, me, body, m, q, client):
        me = self.need(me)
        t = self._target(db, m.group(1))
        role = body.get("role")
        if role not in ROLES:
            raise ApiError(400, "Unknown role.")
        if not can_manage(me, t, role):
            raise ApiError(403, "You can't give that person that role.")
        if role == t["role"]:
            return {"id": t["id"], "role": role}
        db.execute("UPDATE users SET role = ?, appointed_by = ? WHERE id = ?", (role, me["id"], t["id"]))
        self.store.audit(db, me["id"], "role_change", f"user:{t['id']}", {"name": t["name"], "from": t["role"], "to": role})
        return {"id": t["id"], "role": role}

    def remove_user(self, db, me, body, m, q, client):
        me = self.need(me)
        t = self._target(db, m.group(1))
        if not can_manage(me, t):
            raise ApiError(403, "You can't remove that person.")
        db.execute("UPDATE users SET active = 0 WHERE id = ?", (t["id"],))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (t["id"],))
        self.store.audit(db, me["id"], "remove_user", f"user:{t['id']}", {"name": t["name"], "role": t["role"]})
        return {"id": t["id"], "active": False}

    def restore_user(self, db, me, body, m, q, client):
        me = self.need(me)
        t = self._target(db, m.group(1))
        if not can_manage(me, t):
            raise ApiError(403, "You can't restore that person.")
        db.execute("UPDATE users SET active = 1 WHERE id = ?", (t["id"],))
        self.store.audit(db, me["id"], "restore_user", f"user:{t['id']}", {"name": t["name"], "role": t["role"]})
        return {"id": t["id"], "active": True}

    def transfer(self, db, me, body, m, q, client):
        me = self.need(me, ("owner",))
        if not check_password(str(body.get("password", "")), me["password_hash"]):
            raise ApiError(403, "Password is wrong.")
        t = self._target(db, body.get("user_id", 0))
        if t["id"] == me["id"] or not t["active"]:
            raise ApiError(400, "Pick another active account.")
        # demote first so the one-owner index never sees two owners
        db.execute("UPDATE users SET role = 'admin', appointed_by = ? WHERE id = ?", (t["id"], me["id"]))
        db.execute("UPDATE users SET role = 'owner', appointed_by = ? WHERE id = ?", (me["id"], t["id"]))
        self.store.audit(db, me["id"], "transfer_ownership", f"user:{t['id']}", {"from": me["name"], "to": t["name"]})
        return {"owner": t["id"]}

    # -- settings and audit
    def set_settings(self, db, me, body, m, q, client):
        me = self.need(me, ("owner",))
        changed = {}
        for k in SETTING_KEYS:
            if k in body:
                v = "1" if body[k] else "0"
                old = "1" if self.store.setting(db, k) else "0"
                if v != old:
                    db.execute("UPDATE settings SET value = ? WHERE key = ?", (v, k))
                    changed[k] = {"from": old == "1", "to": v == "1"}
        if changed:
            self.store.audit(db, me["id"], "settings", "settings", changed)
        return {k: self.store.setting(db, k) for k in SETTING_KEYS}

    def audit_log(self, db, me, body, m, q, client):
        self.need(me, STAFF)
        before = int((q.get("before") or ["0"])[0] or 0)
        rows = db.execute("""SELECT a.*, u.name AS actor_name FROM audit_log a JOIN users u ON u.id = a.actor_id
                             WHERE (? = 0 OR a.id < ?) ORDER BY a.id DESC LIMIT 200""", (before, before)).fetchall()
        return {"items": [{**{k: r[k] for k in ("id", "actor_id", "actor_name", "action", "target", "created_at")},
                           "details": json.loads(r["details"])} for r in rows]}

    # -- dispatch
    def handle(self, method: str, path: str, query: dict, headers, body: dict, client: str):
        for meth, pattern, fn in self.routes():
            if meth != method:
                continue
            m = re.fullmatch(pattern, path)
            if not m:
                continue
            with self.store.lock:
                db = self.store.connect()
                try:
                    db.execute("BEGIN IMMEDIATE")
                    auth = headers.get("Authorization")
                    # unlogged submissions never look at who is signed in
                    anon = fn == self.submit and body.get("mode") == "unlogged"
                    me = None if anon else self.current_user(db, auth)
                    out = fn(db, me, body, m, query, client)
                    db.execute("COMMIT")
                    return 200, out
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
                finally:
                    db.close()
        raise ApiError(404, "Not found.")


# ---------------------------------------------------------------- HTTP

def make_handler(api: Api, allow_origin: str, trust_proxy: bool):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MogServer/1"

        def log_message(self, fmt, *args):
            # No client addresses in logs: unlogged contributions must stay untraceable.
            sys.stderr.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

        def address_string(self):
            return "-"

        def client_key(self) -> str:
            if trust_proxy and self.headers.get("X-Forwarded-For"):
                return self.headers["X-Forwarded-For"].split(",")[0].strip()
            return self.client_address[0]

        def cors(self):
            self.send_header("Access-Control-Allow-Origin", allow_origin)
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Range, ngrok-skip-browser-warning")
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
            if allow_origin != "*":
                self.send_header("Vary", "Origin")

        def send(self, status: int, payload: dict):
            data = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def send_raw(self, raw: Raw):
            data, status, extra = raw.data, 200, {}
            rng = self.headers.get("Range", "")
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if m and (m.group(1) or m.group(2)):   # iPhones only play audio from servers that support ranges
                size = len(data)
                if m.group(1):
                    start, end = int(m.group(1)), int(m.group(2) or size - 1)
                else:
                    start, end = max(0, size - int(m.group(2))), size - 1
                end = min(end, size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.cors()
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                data, status = data[start:end + 1], 206
                extra["Content-Range"] = f"bytes {start}-{end}/{size}"
            self.send_response(status)
            self.cors()
            self.send_header("Content-Type", raw.mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "public, max-age=86400" if raw.public else "private, no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def run(self, method):
            u = urlparse(self.path)
            body = {}
            try:
                if method == "POST":
                    n = int(self.headers.get("Content-Length") or 0)
                    if n > MAX_BODY:
                        raise ApiError(413, "Too big.")
                    raw = self.rfile.read(n) if n else b"{}"
                    try:
                        body = json.loads(raw or b"{}")
                    except ValueError:
                        raise ApiError(400, "Send JSON.")
                    if not isinstance(body, dict):
                        raise ApiError(400, "Send a JSON object.")
                status, out = api.handle(method, u.path.rstrip("/") or "/", parse_qs(u.query), self.headers, body, self.client_key())
                if isinstance(out, Raw):
                    self.send_raw(out)
                else:
                    self.send(status, out)
            except ApiError as e:
                self.send(e.status, {"error": e.message})
            except sqlite3.IntegrityError:
                self.send(409, {"error": "That conflicts with existing data."})
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f"error: {type(e).__name__}: {e}\n")
                self.send(500, {"error": "Server error."})

        def do_GET(self):
            self.run("GET")

        def do_POST(self):
            self.run("POST")

    return Handler


def main(argv=None):
    p = argparse.ArgumentParser(description="Mog Translator contribution server")
    p.add_argument("--db", default=os.environ.get("MOG_DB", "mog.db"), help="SQLite file (default mog.db)")
    sub = p.add_subparsers(dest="cmd", required=True)
    o = sub.add_parser("init-owner", help="create the owner account (only if none exists)")
    o.add_argument("--name", required=True)
    s = sub.add_parser("serve", help="run the API")
    s.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    s.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8787")))
    s.add_argument("--allow-origin", default=os.environ.get("MOG_ALLOW_ORIGIN", "*"),
                   help="CORS origin allowed to call the API (default *; logins use tokens, not cookies)")
    s.add_argument("--trust-proxy", action="store_true", default=os.environ.get("MOG_TRUST_PROXY") == "1",
                   help="use X-Forwarded-For for rate limits (only behind your own HTTPS proxy)")
    a = p.parse_args(argv)
    store = Store(a.db)

    if a.cmd == "init-owner":
        pw = os.environ.get("MOG_OWNER_PASSWORD") or getpass.getpass("Owner password (8+ characters): ")
        try:
            uid = store.create_owner(a.name, pw)
        except ApiError as e:
            sys.exit(e.message)
        print(f"Owner '{a.name}' created (id {uid}).")
        return

    srv = ThreadingHTTPServer((a.host, a.port), make_handler(Api(store), a.allow_origin, a.trust_proxy))
    print(f"Mog server on http://{a.host}:{a.port}  db={a.db}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
