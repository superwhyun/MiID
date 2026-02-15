-- Managed DID SSO baseline schema (PostgreSQL)
-- Requires: pgcrypto extension for gen_random_uuid()

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS did_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  did TEXT NOT NULL UNIQUE,
  did_method TEXT NOT NULL,
  public_jwk JSONB NOT NULL,
  kms_key_ref TEXT,
  key_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_did_identities_user_id ON did_identities(user_id);

CREATE TABLE IF NOT EXISTS service_subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_id, user_id),
  UNIQUE (service_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_service_subjects_user_id ON service_subjects(user_id);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  requested_scopes JSONB NOT NULL,
  state TEXT,
  nonce TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at ON auth_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_used_at ON auth_challenges(used_at);

CREATE TABLE IF NOT EXISTS auth_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES auth_challenges(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_subject_id ON auth_codes(subject_id);
CREATE INDEX IF NOT EXISTS idx_auth_codes_expires_at ON auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  scopes JSONB NOT NULL,
  scope_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

-- same scope can only have one active consent per service+subject
CREATE UNIQUE INDEX IF NOT EXISTS ux_consents_active_scope
ON consents(service_id, subject_id, scope_hash)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_consents_lookup ON consents(service_id, subject_id, status);

CREATE TABLE IF NOT EXISTS consent_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id UUID NOT NULL REFERENCES consents(id) ON DELETE CASCADE,
  action TEXT NOT NULL, -- granted | upgraded | revoked | expired
  actor TEXT NOT NULL,  -- user | system | admin
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail JSONB
);

CREATE INDEX IF NOT EXISTS idx_consent_audit_logs_consent_id ON consent_audit_logs(consent_id);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  did TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'normal', -- normal | step_up
  access_token_jti TEXT NOT NULL UNIQUE,
  refresh_token_jti TEXT UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_subject_service ON sessions(subject_id, service_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
