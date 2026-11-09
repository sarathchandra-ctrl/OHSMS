-- One-time setup on PlanetScale Postgres (or any hosted Postgres whose app
-- user may not create roles). Run it ONCE in the PlanetScale console
-- (database → Console, or "Connect" → psql) as the default `postgres` role.
--
-- Replace APP_USER with the user the app connects as. /health shows it under
-- "seen.user" (for PlanetScale it is the part of the Hyperdrive user BEFORE the
-- dot — the part after the dot only routes to the branch).

CREATE ROLE ohsms_browser NOLOGIN;
CREATE ROLE ohsms_worker NOLOGIN;

-- The app switches into these two roles for every request.
GRANT ohsms_browser, ohsms_worker TO "pscale_api_zwkn59kxucaa";

-- The app creates its own tables, policies and functions in `public`, and
-- hands its security-definer functions to ohsms_worker.
GRANT USAGE, CREATE ON SCHEMA public TO "pscale_api_zwkn59kxucaa";
GRANT USAGE, CREATE ON SCHEMA public TO ohsms_worker;

-- Optional. If PlanetScale allows it, this lets the server role skip
-- row-level security outright. If it is refused, nothing breaks: the schema
-- gives ohsms_worker explicit allow-all policies instead.
-- ALTER ROLE ohsms_worker BYPASSRLS;
