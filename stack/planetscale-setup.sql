-- One-time setup on PlanetScale Postgres (or any hosted Postgres whose app
-- user may not create roles). Run it ONCE in the PlanetScale console
-- (database → Console, or "Connect" → psql) as the default `postgres` role.
--
-- Replace APP_USER with the user Hyperdrive connects as (Cloudflare → Hyperdrive
-- → your config → "User"), keeping the double quotes: it contains a dot.

CREATE ROLE ohsms_browser NOLOGIN;
CREATE ROLE ohsms_worker NOLOGIN;

-- The app switches into these two roles for every request.
GRANT ohsms_browser, ohsms_worker TO "APP_USER";

-- The app creates its own tables, policies and functions in `public`, and
-- hands its security-definer functions to ohsms_worker.
GRANT USAGE, CREATE ON SCHEMA public TO "APP_USER";
GRANT USAGE, CREATE ON SCHEMA public TO ohsms_worker;

-- Optional. If PlanetScale allows it, this lets the server role skip
-- row-level security outright. If it is refused, nothing breaks: the schema
-- gives ohsms_worker explicit allow-all policies instead.
-- ALTER ROLE ohsms_worker BYPASSRLS;
