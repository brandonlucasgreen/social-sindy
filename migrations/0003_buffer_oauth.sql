-- "Sign in with Buffer": OAuth replaces the pasted personal API key.
--
-- A personal key grants full account access including publishing. OAuth lets
-- this ask for read-only scopes instead, which is what the product actually
-- needs and what the interface promises.
--
-- Kept in its own table rather than added to `credentials` so both paths can
-- coexist: users who connected with a key keep working untouched, and a user
-- who upgrades has their key row deleted rather than reinterpreted.
CREATE TABLE buffer_oauth_credentials (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The refresh token, sealed with AES-256-GCM. Buffer ROTATES this on every
  -- use, so this row is rewritten on each refresh — it is not write-once.
  ciphertext   TEXT NOT NULL,
  iv           TEXT NOT NULL,
  -- Granted scopes, recorded so a downgrade is detectable at consent time.
  scope        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  -- Bumped on every rotation. Doubles as the conflict signal: a refresh that
  -- fails because another request already rotated the token can re-read this
  -- row and retry with whatever the winner stored.
  updated_at   TEXT NOT NULL
);
