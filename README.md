# Section Portal

Flask + SQLite backend, plain HTML/CSS/JS frontend (served by Flask).

## Run locally
```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export ADMIN_EMAIL="you@example.com" ADMIN_PASSWORD="a-long-password"   # Windows: set ...
python app.py                                           # http://127.0.0.1:5000
```
The admin account is created on first start from those two variables.

## Roles
| | student | cr | admin |
|---|---|---|---|
| View everything | yes | yes | yes |
| Own attendance, event RSVP | yes | yes | yes |
| Announcements, events, assignments, timetable | no | yes | yes |
| Change user roles | no | no | yes |

New sign-ups are always students. Log in as admin, open CR Portal, and set a classmate to `cr`.
All checks run in `app.py`; hiding buttons in the page is only cosmetic.

## Production
- `pip install -r requirements.txt && HTTPS=1 SECRET_KEY=<random> gunicorn -w 2 app:app`
- Serve behind HTTPS (Nginx/Caddy or your host). `HTTPS=1` marks the session cookie Secure.
- Back up `portal.db` regularly. Set `DB_PATH` to keep it on a persistent disk.
