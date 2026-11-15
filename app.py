"""Section Portal backend (Flask + SQLite).

Roles:  student < cr < admin
  student : read everything, write ONLY own attendance and own event RSVPs
  cr      : everything a student can + create/delete announcements, events,
            assignments and edit the timetable
  admin   : everything a CR can + manage users / change roles
Every rule below is enforced here on the server, not in the browser.
"""
import json, os, re, secrets, sqlite3, time
from functools import wraps
from flask import Flask, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE, "portal.db"))
SUBJECTS = ["icp", "upm", "calc", "uhv", "em"]
CATS = ["Academic", "Exam", "General"]
ROLES = ["student", "cr", "admin"]

app = Flask(__name__, static_folder=os.path.join(BASE, "static"), static_url_path="/static")
if os.environ.get("BEHIND_PROXY") == "1":  # hosts like PythonAnywhere sit behind a proxy; use the real client IP
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)


def _secret():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    p = os.path.join(BASE, ".secret_key")
    if not os.path.exists(p):
        with open(p, "w") as f:
            f.write(secrets.token_hex(32))
    return open(p).read().strip()


app.config.update(
    SECRET_KEY=_secret(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("HTTPS") == "1",  # set HTTPS=1 in production
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 14,
    MAX_CONTENT_LENGTH=64 * 1024,
)

DEFAULT_TT = [
    ["09:00", ["ICP", "UPM", "Calculus", "UHV", "Eng. Math", "ICP Lab", "—"]],
    ["10:00", ["UPM", "Calculus", "Eng. Math", "ICP", "UHV", "ICP Lab", "—"]],
    ["11:00", ["Calculus", "Eng. Math", "ICP", "UPM", "Calculus", "—", "—"]],
    ["12:00", ["Lunch"] * 5 + ["—", "—"]],
    ["14:00", ["UHV", "ICP Lab", "UPM", "Eng. Math", "UPM Lab", "—", "—"]],
    ["15:00", ["Eng. Math", "ICP Lab", "UHV", "Calculus", "UPM Lab", "—", "—"]],
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', approved INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY, title TEXT, body TEXT, cat TEXT,
  pinned INTEGER DEFAULT 0, author TEXT, created TEXT DEFAULT (date('now')));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, title TEXT, date TEXT, place TEXT);
CREATE TABLE IF NOT EXISTS assignments(id INTEGER PRIMARY KEY, day INTEGER, subject TEXT, title TEXT, due TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS attendance(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, subject TEXT,
  attended INTEGER DEFAULT 0, total INTEGER DEFAULT 0, PRIMARY KEY(user_id, subject));
CREATE TABLE IF NOT EXISTS rsvps(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE, PRIMARY KEY(user_id, event_id));
CREATE TABLE IF NOT EXISTS exams(id INTEGER PRIMARY KEY, title TEXT, subject TEXT, date TEXT, time TEXT, venue TEXT);
CREATE TABLE IF NOT EXISTS links(id INTEGER PRIMARY KEY, kind TEXT, title TEXT, url TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, kind TEXT, title TEXT, created TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS att_log(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT, attended INTEGER, ts TEXT DEFAULT (datetime('now')));
"""


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def _close(_):
    d = g.pop("db", None)
    if d:
        d.close()


def init_db():
    with app.app_context():
        d = db()
        d.executescript(SCHEMA)
        cols = [r["name"] for r in d.execute("PRAGMA table_info(users)")]
        if "approved" not in cols:
            d.execute("ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1")  # existing users stay approved
        if "seen_nid" not in cols:
            d.execute("ALTER TABLE users ADD COLUMN seen_nid INTEGER NOT NULL DEFAULT 0")
        if not d.execute("SELECT 1 FROM settings WHERE key='timetable'").fetchone():
            d.execute("INSERT INTO settings VALUES('timetable',?)", (json.dumps(DEFAULT_TT),))
        email, pw = os.environ.get("ADMIN_EMAIL"), os.environ.get("ADMIN_PASSWORD")
        if email and pw and not d.execute("SELECT 1 FROM users WHERE email=?", (email.lower(),)).fetchone():
            d.execute("INSERT INTO users(name,email,pw_hash,role) VALUES('Admin',?,?, 'admin')",
                      (email.lower(), generate_password_hash(pw)))
        d.commit()


def err(msg, code=400):
    return jsonify(error=msg), code


def clean(v, n, required=True):
    v = (v or "").strip() if isinstance(v, str) else ""
    if required and not v:
        raise ValueError("Please fill in all fields.")
    return v[:n]


def clean_date(v):
    if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        raise ValueError("Invalid date.")
    return v


@app.errorhandler(ValueError)
def _bad(e):
    return err(str(e))


@app.before_request
def _csrf_guard():
    # Cross-site forms cannot set custom headers, so this blocks CSRF on top of SameSite cookies.
    if request.path.startswith("/api/") and request.method in ("POST", "PUT", "DELETE"):
        if request.headers.get("X-Portal") != "1":
            return err("Bad request.", 400)


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    # Role is read from the DB on every request, so demotions take effect immediately.
    return db().execute("SELECT id,name,email,role,approved FROM users WHERE id=?", (uid,)).fetchone()


def need(*roles):
    def deco(f):
        @wraps(f)
        def wrapper(*a, **k):
            u = current_user()
            if not u:
                return err("Please log in.", 401)
            if not u["approved"]:
                session.clear()
                return err("Your account is waiting for approval.", 403)
            if roles and u["role"] not in roles:
                return err("You don't have permission to do that.", 403)
            g.user = u
            return f(*a, **k)
        return wrapper
    return deco


STAFF = ("cr", "admin")
_attempts = {}


def _throttle():
    ip, now = request.remote_addr or "?", time.time()
    _attempts[ip] = [t for t in _attempts.get(ip, []) if now - t < 300]
    if len(_attempts[ip]) >= 10:
        return True
    _attempts[ip].append(now)
    return False


# ---------- auth ----------
@app.post("/api/register")
def register():
    if _throttle():
        return err("Too many attempts. Try again in a few minutes.", 429)
    j = request.get_json(silent=True) or {}
    name, email, pw = clean(j.get("name"), 60), clean(j.get("email"), 120).lower(), j.get("password") or ""
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        return err("Enter a valid email.")
    if len(pw) < 8:
        return err("Password must be at least 8 characters.")
    try:
        cur = db().execute("INSERT INTO users(name,email,pw_hash,role,approved,seen_nid) VALUES(?,?,?, 'student', 0, (SELECT COALESCE(MAX(id),0) FROM notifications))",
                           (name, email, generate_password_hash(pw)))  # always a pending student
        db().commit()
    except sqlite3.IntegrityError:
        return err("That email is already registered.", 409)
    return jsonify(ok=True, pending=True)  # no session until a CR/admin approves


@app.post("/api/login")
def login():
    if _throttle():
        return err("Too many attempts. Try again in a few minutes.", 429)
    j = request.get_json(silent=True) or {}
    u = db().execute("SELECT * FROM users WHERE email=?", (clean(j.get("email"), 120, False).lower(),)).fetchone()
    if not u or not check_password_hash(u["pw_hash"], j.get("password") or ""):
        return err("Wrong email or password.", 401)
    if not u["approved"]:
        return err("Your account is waiting for approval by your CR or admin.", 403)
    session.clear(); session["uid"] = u["id"]; session.permanent = True
    return jsonify(ok=True)


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def me():
    u = current_user()
    return jsonify(user=dict(u) if u else None)


# ---------- read (any logged-in user) ----------
@app.get("/api/data")
@need()
def data():
    d, uid = db(), g.user["id"]
    tt = json.loads(d.execute("SELECT value FROM settings WHERE key='timetable'").fetchone()["value"])
    return jsonify(
        timetable=tt,
        announcements=[dict(r) for r in d.execute("SELECT * FROM announcements ORDER BY pinned DESC, created DESC, id DESC")],
        events=[dict(r) for r in d.execute(
            "SELECT e.*, (SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id) AS going FROM events e ORDER BY date")],
        assignments=[dict(r) for r in d.execute("SELECT * FROM assignments ORDER BY due")],
        attendance={r["subject"]: {"att": r["attended"], "total": r["total"]}
                    for r in d.execute("SELECT * FROM attendance WHERE user_id=?", (uid,))},
        my_rsvps=[r["event_id"] for r in d.execute("SELECT event_id FROM rsvps WHERE user_id=?", (uid,))],
        exams=[dict(r) for r in d.execute("SELECT * FROM exams ORDER BY date, time")],
        links=[dict(r) for r in d.execute("SELECT * FROM links ORDER BY kind, id")],
        att_log=[dict(r) for r in d.execute(
            "SELECT subject,attended,ts FROM att_log WHERE user_id=? ORDER BY id DESC LIMIT 300", (uid,))][::-1],
        **notif_payload(uid),
    )


# ---------- student-allowed writes (own data only) ----------
@app.post("/api/attendance")
@need()
def mark_attendance():
    j = request.get_json(silent=True) or {}
    if j.get("subject") not in SUBJECTS:
        return err("Unknown subject.")
    att, d = (1 if j.get("attended") else 0), db()
    d.execute(
        "INSERT INTO attendance(user_id,subject,attended,total) VALUES(?,?,?,1) "
        "ON CONFLICT(user_id,subject) DO UPDATE SET attended=attended+excluded.attended, total=total+1",
        (g.user["id"], j["subject"], att))
    d.execute("INSERT INTO att_log(user_id,subject,attended) VALUES(?,?,?)", (g.user["id"], j["subject"], att))
    d.commit()
    return jsonify(ok=True)


@app.post("/api/attendance/undo")
@need()
def undo_attendance():
    subj, uid, d = (request.get_json(silent=True) or {}).get("subject"), g.user["id"], db()
    if subj not in SUBJECTS:
        return err("Unknown subject.")
    row = d.execute("SELECT id,attended FROM att_log WHERE user_id=? AND subject=? ORDER BY id DESC LIMIT 1",
                    (uid, subj)).fetchone()
    if not row:
        return err("Nothing to undo for this subject.")
    d.execute("DELETE FROM att_log WHERE id=?", (row["id"],))
    d.execute("UPDATE attendance SET attended=MAX(0,attended-?), total=MAX(0,total-1) WHERE user_id=? AND subject=?",
              (row["attended"], uid, subj))
    d.execute("DELETE FROM attendance WHERE user_id=? AND subject=? AND total=0", (uid, subj))
    d.commit()
    return jsonify(ok=True)


@app.post("/api/attendance/reset")
@need()
def reset_attendance():
    db().execute("DELETE FROM attendance WHERE user_id=?", (g.user["id"],))
    db().execute("DELETE FROM att_log WHERE user_id=?", (g.user["id"],))
    db().commit()
    return jsonify(ok=True)


@app.put("/api/rsvp/<int:eid>")
@need()
def rsvp(eid):
    d = db()
    if not d.execute("SELECT 1 FROM events WHERE id=?", (eid,)).fetchone():
        return err("Event not found.", 404)
    if (request.get_json(silent=True) or {}).get("going"):
        d.execute("INSERT OR IGNORE INTO rsvps VALUES(?,?)", (g.user["id"], eid))
    else:
        d.execute("DELETE FROM rsvps WHERE user_id=? AND event_id=?", (g.user["id"], eid))
    d.commit()
    return jsonify(ok=True)


# ---------- CR / admin only ----------
def notify(kind, title):
    d = db()
    d.execute("INSERT INTO notifications(kind,title) VALUES(?,?)", (kind, title[:120]))
    d.execute("DELETE FROM notifications WHERE id <= (SELECT MAX(id) FROM notifications) - 100")
    d.commit()


def notif_payload(uid):
    d = db()
    seen = d.execute("SELECT seen_nid FROM users WHERE id=?", (uid,)).fetchone()["seen_nid"]
    rows = [dict(r) for r in d.execute("SELECT * FROM notifications ORDER BY id DESC LIMIT 30")]
    return {"notifications": rows, "unread": sum(1 for r in rows if r["id"] > seen)}


@app.get("/api/notifications")
@need()
def notifications():
    return jsonify(**notif_payload(g.user["id"]))


@app.post("/api/notifications/seen")
@need()
def notifications_seen():
    db().execute("UPDATE users SET seen_nid=(SELECT COALESCE(MAX(id),0) FROM notifications) WHERE id=?", (g.user["id"],))
    db().commit()
    return jsonify(ok=True)


def _ann_vals(j):
    cat = j.get("cat") if j.get("cat") in CATS else "General"
    return clean(j.get("title"), 80), clean(j.get("body"), 400), cat, 1 if j.get("pin") else 0


@app.post("/api/announcements")
@need(*STAFF)
def add_announcement():
    t, b, c, p = _ann_vals(request.get_json(silent=True) or {})
    d = db()
    if p:
        d.execute("UPDATE announcements SET pinned=0")
    d.execute("INSERT INTO announcements(title,body,cat,pinned,author) VALUES(?,?,?,?,?)",
              (t, b, c, p, "Admin" if g.user["role"] == "admin" else "CR"))
    d.commit()
    notify("announcement", f"New announcement: {t}")
    return jsonify(ok=True)


@app.put("/api/announcements/<int:i>")
@need(*STAFF)
def edit_announcement(i):
    t, b, c, p = _ann_vals(request.get_json(silent=True) or {})
    d = db()
    if p:
        d.execute("UPDATE announcements SET pinned=0 WHERE id<>?", (i,))
    cur = d.execute("UPDATE announcements SET title=?,body=?,cat=?,pinned=? WHERE id=?", (t, b, c, p, i))
    d.commit()
    if not cur.rowcount:
        return err("Not found.", 404)
    notify("announcement", f"Announcement updated: {t}")
    return jsonify(ok=True)


@app.delete("/api/announcements/<int:i>")
@need(*STAFF)
def del_announcement(i):
    db().execute("DELETE FROM announcements WHERE id=?", (i,)); db().commit()
    return jsonify(ok=True)


def clean_url(v):
    v = clean(v, 300)
    if not re.fullmatch(r"https?://[^\s]+", v):  # blocks javascript: and other schemes
        raise ValueError("Link must start with http:// or https://")
    return v


def crud(name, cols, parse, label, tidx=0, kind=None):
    """POST/PUT/DELETE /api/<name>, CR/admin only. parse(json) -> tuple matching cols."""
    ins = f"INSERT INTO {name}({','.join(cols)}) VALUES({','.join('?' * len(cols))})"
    upd = f"UPDATE {name} SET {','.join(c + '=?' for c in cols)} WHERE id=?"

    @need(*STAFF)
    def create():
        v = parse(request.get_json(silent=True) or {})
        db().execute(ins, v); db().commit()
        if kind:
            notify(kind, f"New {label}: {v[tidx]}")
        return jsonify(ok=True)

    @need(*STAFF)
    def update(i):
        v = parse(request.get_json(silent=True) or {})
        cur = db().execute(upd, (*v, i)); db().commit()
        if not cur.rowcount:
            return err("Not found.", 404)
        if kind:
            notify(kind, f"Updated {label}: {v[tidx]}")
        return jsonify(ok=True)

    @need(*STAFF)
    def delete(i):
        db().execute(f"DELETE FROM {name} WHERE id=?", (i,)); db().commit()
        return jsonify(ok=True)

    app.add_url_rule(f"/api/{name}", f"create_{name}", create, methods=["POST"])
    app.add_url_rule(f"/api/{name}/<int:i>", f"update_{name}", update, methods=["PUT"])
    app.add_url_rule(f"/api/{name}/<int:i>", f"delete_{name}", delete, methods=["DELETE"])


crud("events", ("title", "date", "place"),
     lambda j: (clean(j.get("title"), 60), clean_date(j.get("date")), clean(j.get("place"), 60, False)), "event", 0, "event")
crud("assignments", ("subject", "title", "due"),
     lambda j: (clean(j.get("subject"), 30), clean(j.get("title"), 80), clean_date(j.get("due"))), "assignment", 1, "assignment")
crud("exams", ("title", "subject", "date", "time", "venue"),
     lambda j: (clean(j.get("title"), 40), clean(j.get("subject"), 30, False), clean_date(j.get("date")),
                clean(j.get("time"), 20, False), clean(j.get("venue"), 40, False)), "exam", 0, "exam")
crud("links", ("kind", "title", "url", "note"),
     lambda j: (j.get("kind") if j.get("kind") in ("resource", "social") else "resource", clean(j.get("title"), 60),
                clean_url(j.get("url")), clean(j.get("note"), 80, False)), "link", 1, None)


@app.put("/api/timetable")
@need(*STAFF)
def set_timetable():
    rows = (request.get_json(silent=True) or {}).get("rows")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 14:
        return err("Invalid timetable.")
    out = []
    for r in rows:
        if not isinstance(r, list) or len(r) != 2 or not isinstance(r[1], list) or len(r[1]) != 7:
            return err("Invalid timetable.")
        out.append([clean(r[0], 24), [clean(c, 30, False) or "—" for c in r[1]]])
    db().execute("INSERT OR REPLACE INTO settings VALUES('timetable',?)", (json.dumps(out),))
    db().commit()
    notify("timetable", "Timetable updated")
    return jsonify(ok=True)


# ---------- admin only ----------
@app.get("/api/users")
@need("admin")
def users():
    return jsonify(users=[dict(r) for r in db().execute("SELECT id,name,email,role,approved FROM users ORDER BY approved, role, name")])


@app.put("/api/users/<int:i>/role")
@need("admin")
def set_role(i):
    role = (request.get_json(silent=True) or {}).get("role")
    if role not in ROLES:
        return err("Invalid role.")
    if i == g.user["id"]:
        return err("You can't change your own role.")
    db().execute("UPDATE users SET role=? WHERE id=?", (role, i)); db().commit()
    return jsonify(ok=True)


@app.get("/api/pending")
@need(*STAFF)
def pending():
    return jsonify(pending=[dict(r) for r in db().execute("SELECT id,name,email FROM users WHERE approved=0 ORDER BY id")])


@app.post("/api/users/<int:i>/approve")
@need(*STAFF)
def approve(i):
    cur = db().execute("UPDATE users SET approved=1 WHERE id=? AND approved=0", (i,)); db().commit()
    return jsonify(ok=True) if cur.rowcount else err("No pending request.", 404)


@app.delete("/api/users/<int:i>")
@need(*STAFF)
def remove_user(i):
    # CR: may only reject pending students. Admin: may remove anyone except themselves.
    row = db().execute("SELECT approved,role FROM users WHERE id=?", (i,)).fetchone()
    if not row:
        return err("User not found.", 404)
    if i == g.user["id"]:
        return err("You can't remove yourself.")
    if g.user["role"] != "admin" and (row["approved"] or row["role"] != "student"):
        return err("Only the admin can remove active members.", 403)
    db().execute("DELETE FROM users WHERE id=?", (i,)); db().commit()  # cascades attendance + RSVPs
    return jsonify(ok=True)


# ---------- frontend ----------
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
