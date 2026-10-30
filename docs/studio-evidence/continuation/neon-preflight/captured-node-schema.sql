


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA release_smoke_20261030_0236;


SET default_tablespace = '';

SET default_table_access_method = heap;


CREATE TABLE release_smoke_20261030_0236.artifacts (
    id text NOT NULL,
    project_id text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    ystate bytea,
    updated_at text NOT NULL,
    created_at text NOT NULL,
    created_by text NOT NULL,
    archived bigint DEFAULT 0 NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.artifacts_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.artifacts_ordinal_seq OWNED BY release_smoke_20261030_0236.artifacts.ordinal;



CREATE TABLE release_smoke_20261030_0236.audio_render_jobs (
    sequence bigint NOT NULL,
    id text NOT NULL,
    artifact_id text NOT NULL,
    artifact_version bigint NOT NULL,
    user_id text NOT NULL,
    format text NOT NULL,
    status text NOT NULL,
    progress real DEFAULT 0 NOT NULL,
    file_id text,
    error text,
    created_at text NOT NULL,
    finished_at text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.audio_render_jobs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.audio_render_jobs_ordinal_seq OWNED BY release_smoke_20261030_0236.audio_render_jobs.ordinal;



CREATE TABLE release_smoke_20261030_0236.audit (
    id bigint NOT NULL,
    project_id text NOT NULL,
    artifact_id text,
    actor text NOT NULL,
    action text NOT NULL,
    detail text NOT NULL,
    created_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.audit_id_seq OWNED BY release_smoke_20261030_0236.audit.id;



CREATE SEQUENCE release_smoke_20261030_0236.audit_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.audit_ordinal_seq OWNED BY release_smoke_20261030_0236.audit.ordinal;



CREATE TABLE release_smoke_20261030_0236.decisions (
    id text NOT NULL,
    artifact_id text NOT NULL,
    title text NOT NULL,
    context text NOT NULL,
    decision text NOT NULL,
    consequences text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    author text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.decisions_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.decisions_ordinal_seq OWNED BY release_smoke_20261030_0236.decisions.ordinal;



CREATE TABLE release_smoke_20261030_0236.document_answers (
    id text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    anchor text NOT NULL,
    question_id text NOT NULL,
    option_id text NOT NULL,
    answer text NOT NULL,
    question text NOT NULL,
    option text NOT NULL,
    question_snapshot text NOT NULL,
    author_id text NOT NULL,
    author text NOT NULL,
    created_at text NOT NULL,
    decision_id text,
    supersedes_id text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.document_answers_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.document_answers_ordinal_seq OWNED BY release_smoke_20261030_0236.document_answers.ordinal;



CREATE TABLE release_smoke_20261030_0236.document_decision_anchors (
    id text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    decision_id text NOT NULL,
    anchor text NOT NULL,
    source_id text NOT NULL,
    source_kind text NOT NULL,
    created_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.document_decision_anchors_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.document_decision_anchors_ordinal_seq OWNED BY release_smoke_20261030_0236.document_decision_anchors.ordinal;



CREATE TABLE release_smoke_20261030_0236.document_suggestions (
    id text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    anchor text NOT NULL,
    before_text text NOT NULL,
    after_text text NOT NULL,
    range_from bigint NOT NULL,
    range_to bigint NOT NULL,
    block_snapshot text NOT NULL,
    base_version bigint NOT NULL,
    author_id text NOT NULL,
    author text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resolved_by text,
    created_at text NOT NULL,
    resolved_at text,
    comment text NOT NULL,
    ordinal bigint NOT NULL,
    CONSTRAINT document_suggestions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))
);



CREATE SEQUENCE release_smoke_20261030_0236.document_suggestions_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.document_suggestions_ordinal_seq OWNED BY release_smoke_20261030_0236.document_suggestions.ordinal;



CREATE TABLE release_smoke_20261030_0236.files (
    id text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    name text NOT NULL,
    mime text NOT NULL,
    sha256 text NOT NULL,
    bytes bytea NOT NULL,
    created_at text NOT NULL,
    storage_key text,
    byte_size bigint DEFAULT 0 NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.files_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.files_ordinal_seq OWNED BY release_smoke_20261030_0236.files.ordinal;



CREATE TABLE release_smoke_20261030_0236.identity_challenges (
    namespace text NOT NULL,
    state_hash text NOT NULL,
    binding_hash text NOT NULL,
    payload text NOT NULL,
    user_id text,
    session_hash text,
    expires_at bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.identity_challenges_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.identity_challenges_ordinal_seq OWNED BY release_smoke_20261030_0236.identity_challenges.ordinal;



CREATE TABLE release_smoke_20261030_0236.implementation_commands (
    run_id text NOT NULL,
    key text NOT NULL,
    actor_key text NOT NULL,
    request_hash text NOT NULL,
    response text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.implementation_commands_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.implementation_commands_ordinal_seq OWNED BY release_smoke_20261030_0236.implementation_commands.ordinal;



CREATE TABLE release_smoke_20261030_0236.implementation_draft_requests (
    artifact_id text NOT NULL,
    user_id text NOT NULL,
    request_id text NOT NULL,
    job_id text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.implementation_draft_requests_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.implementation_draft_requests_ordinal_seq OWNED BY release_smoke_20261030_0236.implementation_draft_requests.ordinal;



CREATE TABLE release_smoke_20261030_0236.implementation_events (
    artifact_id text NOT NULL,
    revision bigint NOT NULL,
    payload text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.implementation_events_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.implementation_events_ordinal_seq OWNED BY release_smoke_20261030_0236.implementation_events.ordinal;



CREATE TABLE release_smoke_20261030_0236.implementation_graphs (
    artifact_id text NOT NULL,
    version bigint NOT NULL,
    payload text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.implementation_graphs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.implementation_graphs_ordinal_seq OWNED BY release_smoke_20261030_0236.implementation_graphs.ordinal;



CREATE TABLE release_smoke_20261030_0236.implementation_heads (
    artifact_id text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    active_run_id text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.implementation_heads_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.implementation_heads_ordinal_seq OWNED BY release_smoke_20261030_0236.implementation_heads.ordinal;



CREATE TABLE release_smoke_20261030_0236.implementation_runs (
    id text NOT NULL,
    artifact_id text NOT NULL,
    graph_version bigint NOT NULL,
    status text NOT NULL,
    payload text NOT NULL,
    started_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.implementation_runs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.implementation_runs_ordinal_seq OWNED BY release_smoke_20261030_0236.implementation_runs.ordinal;



CREATE TABLE release_smoke_20261030_0236.links (
    id text NOT NULL,
    artifact_id text NOT NULL,
    label text NOT NULL,
    url text NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'unknown'::text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.links_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.links_ordinal_seq OWNED BY release_smoke_20261030_0236.links.ordinal;



CREATE TABLE release_smoke_20261030_0236.memberships (
    project_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    ordinal bigint NOT NULL,
    CONSTRAINT memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'editor'::text, 'viewer'::text])))
);



CREATE SEQUENCE release_smoke_20261030_0236.memberships_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.memberships_ordinal_seq OWNED BY release_smoke_20261030_0236.memberships.ordinal;



CREATE TABLE release_smoke_20261030_0236.messages (
    id text NOT NULL,
    artifact_id text NOT NULL,
    thread_id text NOT NULL,
    author_id text NOT NULL,
    author text NOT NULL,
    role text NOT NULL,
    body text NOT NULL,
    proposal text,
    created_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.messages_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.messages_ordinal_seq OWNED BY release_smoke_20261030_0236.messages.ordinal;



CREATE TABLE release_smoke_20261030_0236.projects (
    id text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    repository text DEFAULT ''::text NOT NULL,
    main_artifact_id text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.projects_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.projects_ordinal_seq OWNED BY release_smoke_20261030_0236.projects.ordinal;



CREATE TABLE release_smoke_20261030_0236.repository_identities (
    user_id text NOT NULL,
    github_id text NOT NULL,
    login text NOT NULL,
    access_cipher text NOT NULL,
    refresh_cipher text,
    access_expires bigint DEFAULT 0 NOT NULL,
    refresh_expires bigint DEFAULT 0 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    generation text NOT NULL,
    permission_version bigint DEFAULT 1 NOT NULL,
    refresh_owner text,
    refresh_until bigint DEFAULT 0 NOT NULL,
    updated_at bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.repository_identities_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.repository_identities_ordinal_seq OWNED BY release_smoke_20261030_0236.repository_identities.ordinal;



CREATE TABLE release_smoke_20261030_0236.repository_identity_epochs (
    user_id text NOT NULL,
    epoch text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.repository_identity_epochs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.repository_identity_epochs_ordinal_seq OWNED BY release_smoke_20261030_0236.repository_identity_epochs.ordinal;



CREATE TABLE release_smoke_20261030_0236.repository_identity_leases (
    user_id text NOT NULL,
    repository text NOT NULL,
    action text NOT NULL,
    identity_version bigint NOT NULL,
    identity_generation text NOT NULL,
    permission_version bigint DEFAULT 1 NOT NULL,
    expires_at bigint NOT NULL,
    ordinal bigint NOT NULL,
    CONSTRAINT repository_identity_leases_action_check CHECK ((action = ANY (ARRAY['read'::text, 'write'::text])))
);



CREATE SEQUENCE release_smoke_20261030_0236.repository_identity_leases_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.repository_identity_leases_ordinal_seq OWNED BY release_smoke_20261030_0236.repository_identity_leases.ordinal;



CREATE TABLE release_smoke_20261030_0236.revisions (
    id bigint NOT NULL,
    artifact_id text NOT NULL,
    version bigint NOT NULL,
    content text NOT NULL,
    actor text NOT NULL,
    created_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.revisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.revisions_id_seq OWNED BY release_smoke_20261030_0236.revisions.id;



CREATE SEQUENCE release_smoke_20261030_0236.revisions_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.revisions_ordinal_seq OWNED BY release_smoke_20261030_0236.revisions.ordinal;



CREATE TABLE release_smoke_20261030_0236.runs (
    id text NOT NULL,
    artifact_id text NOT NULL,
    artifact_version bigint NOT NULL,
    status text NOT NULL,
    result text,
    error text,
    created_at text NOT NULL,
    finished_at text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.runs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.runs_ordinal_seq OWNED BY release_smoke_20261030_0236.runs.ordinal;



CREATE TABLE release_smoke_20261030_0236.sessions (
    token text NOT NULL,
    user_id text NOT NULL,
    expires bigint NOT NULL,
    kind text DEFAULT 'session'::text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.sessions_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.sessions_ordinal_seq OWNED BY release_smoke_20261030_0236.sessions.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_account_machine_bindings (
    account_machine_id text NOT NULL,
    project_id text NOT NULL,
    child_machine_id text NOT NULL,
    checkout_key text NOT NULL,
    repository text NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_account_machine_bindings_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_account_machine_bindings_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_account_machine_bindings.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_account_machine_pairing (
    code_hash text NOT NULL,
    user_id text NOT NULL,
    label text NOT NULL,
    expires bigint NOT NULL,
    trust_version text NOT NULL,
    trusted_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_account_machine_pairing_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_account_machine_pairing_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_account_machine_pairing.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_account_machines (
    id text NOT NULL,
    user_id text NOT NULL,
    label text NOT NULL,
    token_hash text NOT NULL,
    expires bigint NOT NULL,
    last_seen bigint NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    trust_version text NOT NULL,
    trusted_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_account_machines_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_account_machines_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_account_machines.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_agent_jobs (
    id text NOT NULL,
    artifact_id text NOT NULL,
    thread_id text NOT NULL,
    user_id text NOT NULL,
    intent text NOT NULL,
    brief text NOT NULL,
    artifact_version bigint NOT NULL,
    status text NOT NULL,
    child_artifact_id text,
    error text,
    sources text DEFAULT '[]'::text NOT NULL,
    created_at text NOT NULL,
    finished_at text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_agent_jobs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_agent_jobs_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_agent_jobs.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_agent_policy (
    artifact_id text NOT NULL,
    mode text DEFAULT 'manual'::text NOT NULL,
    paused bigint DEFAULT 0 NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_agent_policy_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_agent_policy_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_agent_policy.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_agent_profiles (
    artifact_id text NOT NULL,
    harness text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    updated_by text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_agent_profiles_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_agent_profiles_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_agent_profiles.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_agent_schedule (
    artifact_id text NOT NULL,
    job_id text NOT NULL,
    trigger_id text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_agent_schedule_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_agent_schedule_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_agent_schedule.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_audio_staging (
    object_key text NOT NULL,
    job_id text NOT NULL,
    fence bigint NOT NULL,
    sha256 text NOT NULL,
    byte_size bigint NOT NULL,
    state text NOT NULL,
    created_at bigint NOT NULL,
    next_cleanup bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_audio_staging_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_audio_staging_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_audio_staging.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_conversation_cards (
    id text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    thread_id text NOT NULL,
    snapshot_id text NOT NULL,
    source_hash text NOT NULL,
    artifact_version bigint NOT NULL,
    offer_json text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL,
    updated_by text,
    updated_at text NOT NULL,
    published_id text,
    job_id text,
    error text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_conversation_cards_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_conversation_cards_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_conversation_cards.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_conversation_snapshots (
    id text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    thread_id text NOT NULL,
    source_hash text NOT NULL,
    input_json text NOT NULL,
    principal_id text NOT NULL,
    created_at text NOT NULL,
    job_id text,
    generation bigint DEFAULT 1 NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_conversation_snapshots_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_conversation_snapshots_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_conversation_snapshots.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_decision_admissions (
    call_id text NOT NULL,
    fence bigint NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    admitted_at bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_decision_admissions_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_decision_admissions_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_decision_admissions.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_decision_calls (
    id text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    user_id text NOT NULL,
    artifact_version bigint NOT NULL,
    purpose text NOT NULL,
    input_hash text NOT NULL,
    request_hash text NOT NULL,
    idempotency_key text NOT NULL,
    profile_json text NOT NULL,
    request_json text NOT NULL,
    status text NOT NULL,
    attempts bigint DEFAULT 0 NOT NULL,
    fence bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires bigint,
    result_json text,
    result_sha256 text,
    error_code text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_decision_calls_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_decision_calls_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_decision_calls.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_decision_profiles (
    artifact_id text NOT NULL,
    profile_json text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_by text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_decision_profiles_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_decision_profiles_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_decision_profiles.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_design_flows (
    id text NOT NULL,
    artifact_id text NOT NULL,
    user_id text NOT NULL,
    state text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_design_flows_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_design_flows_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_design_flows.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_design_review_requests (
    artifact_id text NOT NULL,
    user_id text NOT NULL,
    request_id text NOT NULL,
    job_id text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_design_review_requests_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_design_review_requests_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_design_review_requests.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_durable_jobs (
    id text NOT NULL,
    kind text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    principal_id text NOT NULL,
    artifact_version bigint NOT NULL,
    input_json text NOT NULL,
    input_sha256 text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    attempts bigint DEFAULT 0 NOT NULL,
    max_attempts bigint NOT NULL,
    fence bigint DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires bigint,
    available_at bigint NOT NULL,
    progress_json text,
    output_json text,
    error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_durable_jobs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_durable_jobs_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_durable_jobs.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_implementation_machine_queue (
    id text NOT NULL,
    artifact_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    machine_id text NOT NULL,
    expected_json text NOT NULL,
    source_json text NOT NULL,
    source_sha256 text NOT NULL,
    graph_json text NOT NULL,
    repository text NOT NULL,
    source_commit text NOT NULL,
    branch text NOT NULL,
    status text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    lease_hash text,
    verifier_hash text,
    lease_expires bigint,
    run_id text,
    error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_implementation_machine_queue_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_implementation_machine_queue_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_implementation_machine_queue.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_investigation_checkouts (
    machine_id text NOT NULL,
    repository text NOT NULL,
    source_commit text NOT NULL,
    branch text NOT NULL,
    updated_at bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_investigation_checkouts_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_investigation_checkouts_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_investigation_checkouts.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_investigation_consent (
    machine_id text NOT NULL,
    user_id text NOT NULL,
    enabled bigint NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_investigation_consent_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_investigation_consent_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_investigation_consent.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_investigation_decisions (
    id text NOT NULL,
    investigation_id text NOT NULL,
    view_id text NOT NULL,
    selection_revision bigint NOT NULL,
    selection_json text NOT NULL,
    conclusion text NOT NULL,
    rationale text NOT NULL,
    result_hash text NOT NULL,
    author_id text NOT NULL,
    author_name text NOT NULL,
    created_at text NOT NULL,
    sha256 text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_investigation_decisions_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_investigation_decisions_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_investigation_decisions.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_investigation_images (
    investigation_id text NOT NULL,
    file_id text NOT NULL,
    sha256 text NOT NULL,
    generation bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_investigation_images_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_investigation_images_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_investigation_images.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_investigation_passages (
    artifact_id text NOT NULL,
    user_id text NOT NULL,
    digest text NOT NULL,
    investigation_id text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_investigation_passages_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_investigation_passages_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_investigation_passages.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_investigation_selections (
    investigation_id text NOT NULL,
    view_id text NOT NULL,
    revision bigint NOT NULL,
    state_json text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_investigation_selections_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_investigation_selections_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_investigation_selections.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_investigations (
    id text NOT NULL,
    artifact_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    artifact_version bigint NOT NULL,
    source_commit text NOT NULL,
    repository text NOT NULL,
    brief text NOT NULL,
    brief_hash text NOT NULL,
    snapshot_json text NOT NULL,
    status text NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    machine_id text,
    lease_hash text,
    lease_expires bigint,
    started_at bigint,
    result_json text,
    result_hash text,
    child_artifact_id text,
    error text,
    required_reason text,
    mode text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_investigations_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_investigations_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_investigations.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_job_outbox (
    id text NOT NULL,
    intent_key text NOT NULL,
    job_id text NOT NULL,
    status text NOT NULL,
    available_at bigint NOT NULL,
    retry_at bigint NOT NULL,
    attempts bigint DEFAULT 0 NOT NULL,
    dispatch_owner text,
    dispatch_expires bigint,
    receipt_json text,
    error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_job_outbox_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_job_outbox_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_job_outbox.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_job_receipts (
    job_id text NOT NULL,
    name text NOT NULL,
    phase text NOT NULL,
    value_json text NOT NULL,
    value_sha256 text NOT NULL,
    created_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_job_receipts_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_job_receipts_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_job_receipts.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_machine_pairing (
    code_hash text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    label text NOT NULL,
    expires bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_machine_pairing_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_machine_pairing_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_machine_pairing.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_machine_work (
    id text NOT NULL,
    artifact_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    artifact_version bigint NOT NULL,
    kind text NOT NULL,
    brief text NOT NULL,
    status text NOT NULL,
    machine_id text,
    lease_hash text,
    lease_expires bigint,
    result text,
    error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_machine_work_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_machine_work_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_machine_work.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_machines (
    id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    label text NOT NULL,
    token_hash text NOT NULL,
    expires bigint NOT NULL,
    last_seen bigint NOT NULL,
    created_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_machines_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_machines_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_machines.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_planner_owners (
    artifact_id text NOT NULL,
    user_id text NOT NULL,
    epoch bigint NOT NULL,
    expires bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_planner_owners_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_planner_owners_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_planner_owners.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_realtime_clock (
    id bigint NOT NULL,
    sequence bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_realtime_clock_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_realtime_clock_id_seq OWNED BY release_smoke_20261030_0236.studio_realtime_clock.id;



CREATE SEQUENCE release_smoke_20261030_0236.studio_realtime_clock_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_realtime_clock_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_realtime_clock.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_realtime_events (
    sequence bigint NOT NULL,
    id text NOT NULL,
    topic text NOT NULL,
    sender text NOT NULL,
    payload text NOT NULL,
    created_at bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_realtime_events_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_realtime_events_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_realtime_events.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_rebuild_baselines (
    artifact_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    machine_id text NOT NULL,
    run_id text NOT NULL,
    repository text NOT NULL,
    source_json text NOT NULL,
    source_sha256 text NOT NULL,
    source_version bigint NOT NULL,
    graph_json text NOT NULL,
    prs_json text NOT NULL,
    revision bigint NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_rebuild_baselines_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_rebuild_baselines_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_rebuild_baselines.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_rebuild_consent (
    machine_id text NOT NULL,
    user_id text NOT NULL,
    repository text NOT NULL,
    enabled bigint NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_rebuild_consent_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_rebuild_consent_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_rebuild_consent.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_rebuild_execution_receipts (
    rebuild_id text NOT NULL,
    authoring_profile_json text,
    runtime_json text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_rebuild_execution_receipts_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_rebuild_execution_receipts_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_rebuild_execution_receipts.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_rebuild_pending (
    artifact_id text NOT NULL,
    project_id text NOT NULL,
    writer_id text NOT NULL,
    source_sha256 text NOT NULL,
    due_at bigint NOT NULL,
    error text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_rebuild_pending_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_rebuild_pending_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_rebuild_pending.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_rebuild_runs (
    id text NOT NULL,
    artifact_id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    machine_id text NOT NULL,
    baseline_revision bigint NOT NULL,
    base_run_id text NOT NULL,
    repository text NOT NULL,
    before_json text NOT NULL,
    source_json text NOT NULL,
    source_sha256 text NOT NULL,
    source_version bigint NOT NULL,
    graph_json text NOT NULL,
    prs_json text NOT NULL,
    automatic bigint NOT NULL,
    status text NOT NULL,
    generation bigint NOT NULL,
    lease_hash text,
    verifier_hash text,
    lease_expires bigint,
    execution_started bigint DEFAULT 0 NOT NULL,
    report_json text,
    report_hash text,
    verification_json text,
    error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_rebuild_runs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_rebuild_runs_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_rebuild_runs.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_runner_jobs (
    run_id text NOT NULL,
    job_id text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_runner_jobs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_runner_jobs_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_runner_jobs.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_runner_workspaces (
    artifact_id text NOT NULL,
    artifact_version bigint NOT NULL,
    reference_json text,
    revision bigint DEFAULT 0 NOT NULL,
    task_token text,
    task_expires bigint,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_runner_workspaces_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_runner_workspaces_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_runner_workspaces.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_schema (
    id bigint NOT NULL,
    version bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_schema_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_schema_id_seq OWNED BY release_smoke_20261030_0236.studio_schema.id;



CREATE SEQUENCE release_smoke_20261030_0236.studio_schema_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_schema_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_schema.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_spike_candidates (
    artifact_id text NOT NULL,
    user_id text NOT NULL,
    payload text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_spike_candidates_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_spike_candidates_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_spike_candidates.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_spike_checks (
    artifact_id text NOT NULL,
    user_id text NOT NULL,
    source_version bigint NOT NULL,
    created_at bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_spike_checks_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_spike_checks_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_spike_checks.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_title_state (
    artifact_id text NOT NULL,
    mode text NOT NULL,
    epoch bigint DEFAULT 0 NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_title_state_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_title_state_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_title_state.ordinal;



CREATE TABLE release_smoke_20261030_0236.studio_video_staging (
    object_key text NOT NULL,
    job_id text NOT NULL,
    fence bigint NOT NULL,
    sha256 text NOT NULL,
    byte_size bigint NOT NULL,
    state text NOT NULL,
    created_at bigint NOT NULL,
    next_cleanup bigint NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.studio_video_staging_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.studio_video_staging_ordinal_seq OWNED BY release_smoke_20261030_0236.studio_video_staging.ordinal;



CREATE TABLE release_smoke_20261030_0236.threads (
    id text NOT NULL,
    artifact_id text NOT NULL,
    anchor text,
    quote text DEFAULT ''::text NOT NULL,
    resolved bigint DEFAULT 0 NOT NULL,
    created_at text NOT NULL,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.threads_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.threads_ordinal_seq OWNED BY release_smoke_20261030_0236.threads.ordinal;



CREATE TABLE release_smoke_20261030_0236.users (
    id text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    password text,
    color text NOT NULL,
    oidc_sub text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.users_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.users_ordinal_seq OWNED BY release_smoke_20261030_0236.users.ordinal;



CREATE TABLE release_smoke_20261030_0236.video_render_jobs (
    id text NOT NULL,
    artifact_id text NOT NULL,
    artifact_version bigint NOT NULL,
    user_id text NOT NULL,
    format text NOT NULL,
    status text NOT NULL,
    progress real DEFAULT 0 NOT NULL,
    file_id text,
    error text,
    created_at text NOT NULL,
    finished_at text,
    ordinal bigint NOT NULL
);



CREATE SEQUENCE release_smoke_20261030_0236.video_render_jobs_ordinal_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



ALTER SEQUENCE release_smoke_20261030_0236.video_render_jobs_ordinal_seq OWNED BY release_smoke_20261030_0236.video_render_jobs.ordinal;



ALTER TABLE ONLY release_smoke_20261030_0236.artifacts ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.artifacts_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.audio_render_jobs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.audio_render_jobs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.audit ALTER COLUMN id SET DEFAULT nextval('release_smoke_20261030_0236.audit_id_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.audit ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.audit_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.decisions ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.decisions_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.document_answers ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.document_answers_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.document_decision_anchors ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.document_decision_anchors_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.document_suggestions ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.document_suggestions_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.files ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.files_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.identity_challenges ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.identity_challenges_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_commands ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.implementation_commands_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_draft_requests ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.implementation_draft_requests_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_events ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.implementation_events_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_graphs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.implementation_graphs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_heads ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.implementation_heads_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_runs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.implementation_runs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.links ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.links_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.memberships ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.memberships_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.messages ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.messages_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.projects ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.projects_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identities ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.repository_identities_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identity_epochs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.repository_identity_epochs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identity_leases ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.repository_identity_leases_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.revisions ALTER COLUMN id SET DEFAULT nextval('release_smoke_20261030_0236.revisions_id_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.revisions ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.revisions_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.runs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.runs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.sessions ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.sessions_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_bindings ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_account_machine_bindings_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_pairing ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_account_machine_pairing_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machines ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_account_machines_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_jobs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_agent_jobs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_policy ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_agent_policy_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_profiles ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_agent_profiles_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_schedule ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_agent_schedule_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_audio_staging ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_audio_staging_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_cards ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_conversation_cards_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_snapshots ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_conversation_snapshots_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_admissions ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_decision_admissions_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_calls ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_decision_calls_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_profiles ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_decision_profiles_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_flows ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_design_flows_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_review_requests ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_design_review_requests_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_durable_jobs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_durable_jobs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_implementation_machine_queue ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_implementation_machine_queue_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_checkouts ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_investigation_checkouts_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_consent ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_investigation_consent_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_decisions ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_investigation_decisions_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_images ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_investigation_images_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_passages ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_investigation_passages_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_selections ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_investigation_selections_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_investigations_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_outbox ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_job_outbox_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_receipts ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_job_receipts_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_pairing ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_machine_pairing_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_work ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_machine_work_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machines ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_machines_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_planner_owners ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_planner_owners_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_realtime_clock ALTER COLUMN id SET DEFAULT nextval('release_smoke_20261030_0236.studio_realtime_clock_id_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_realtime_clock ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_realtime_clock_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_realtime_events ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_realtime_events_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_baselines ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_rebuild_baselines_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_consent ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_rebuild_consent_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_execution_receipts ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_rebuild_execution_receipts_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_pending ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_rebuild_pending_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_runs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_rebuild_runs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_jobs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_runner_jobs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_workspaces ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_runner_workspaces_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_schema ALTER COLUMN id SET DEFAULT nextval('release_smoke_20261030_0236.studio_schema_id_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_schema ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_schema_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_candidates ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_spike_candidates_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_checks ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_spike_checks_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_title_state ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_title_state_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_video_staging ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.studio_video_staging_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.threads ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.threads_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.users ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.users_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.video_render_jobs ALTER COLUMN ordinal SET DEFAULT nextval('release_smoke_20261030_0236.video_render_jobs_ordinal_seq'::regclass);



ALTER TABLE ONLY release_smoke_20261030_0236.artifacts
    ADD CONSTRAINT artifacts_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.audio_render_jobs
    ADD CONSTRAINT audio_render_jobs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.audio_render_jobs
    ADD CONSTRAINT audio_render_jobs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.audio_render_jobs
    ADD CONSTRAINT audio_render_jobs_sequence_key UNIQUE (sequence);



ALTER TABLE ONLY release_smoke_20261030_0236.audit
    ADD CONSTRAINT audit_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.audit
    ADD CONSTRAINT audit_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.decisions
    ADD CONSTRAINT decisions_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.decisions
    ADD CONSTRAINT decisions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.document_answers
    ADD CONSTRAINT document_answers_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.document_answers
    ADD CONSTRAINT document_answers_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.document_decision_anchors
    ADD CONSTRAINT document_decision_anchors_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.document_decision_anchors
    ADD CONSTRAINT document_decision_anchors_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.document_suggestions
    ADD CONSTRAINT document_suggestions_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.document_suggestions
    ADD CONSTRAINT document_suggestions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.files
    ADD CONSTRAINT files_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.identity_challenges
    ADD CONSTRAINT identity_challenges_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.identity_challenges
    ADD CONSTRAINT identity_challenges_pkey PRIMARY KEY (namespace, state_hash);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_commands
    ADD CONSTRAINT implementation_commands_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_commands
    ADD CONSTRAINT implementation_commands_pkey PRIMARY KEY (run_id, key);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_draft_requests
    ADD CONSTRAINT implementation_draft_requests_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_draft_requests
    ADD CONSTRAINT implementation_draft_requests_pkey PRIMARY KEY (artifact_id, user_id, request_id);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_events
    ADD CONSTRAINT implementation_events_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_events
    ADD CONSTRAINT implementation_events_pkey PRIMARY KEY (artifact_id, revision);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_graphs
    ADD CONSTRAINT implementation_graphs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_graphs
    ADD CONSTRAINT implementation_graphs_pkey PRIMARY KEY (artifact_id, version);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_heads
    ADD CONSTRAINT implementation_heads_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_heads
    ADD CONSTRAINT implementation_heads_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_runs
    ADD CONSTRAINT implementation_runs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_runs
    ADD CONSTRAINT implementation_runs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.links
    ADD CONSTRAINT links_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.memberships
    ADD CONSTRAINT memberships_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (project_id, user_id);



ALTER TABLE ONLY release_smoke_20261030_0236.messages
    ADD CONSTRAINT messages_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.projects
    ADD CONSTRAINT projects_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identities
    ADD CONSTRAINT repository_identities_github_id_key UNIQUE (github_id);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identities
    ADD CONSTRAINT repository_identities_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identities
    ADD CONSTRAINT repository_identities_pkey PRIMARY KEY (user_id);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identity_epochs
    ADD CONSTRAINT repository_identity_epochs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identity_epochs
    ADD CONSTRAINT repository_identity_epochs_pkey PRIMARY KEY (user_id);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identity_leases
    ADD CONSTRAINT repository_identity_leases_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identity_leases
    ADD CONSTRAINT repository_identity_leases_pkey PRIMARY KEY (user_id, repository, action);



ALTER TABLE ONLY release_smoke_20261030_0236.revisions
    ADD CONSTRAINT revisions_artifact_id_version_key UNIQUE (artifact_id, version);



ALTER TABLE ONLY release_smoke_20261030_0236.revisions
    ADD CONSTRAINT revisions_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.revisions
    ADD CONSTRAINT revisions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.runs
    ADD CONSTRAINT runs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.sessions
    ADD CONSTRAINT sessions_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_bindings
    ADD CONSTRAINT studio_account_machine_bindings_child_machine_id_key UNIQUE (child_machine_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_bindings
    ADD CONSTRAINT studio_account_machine_bindings_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_bindings
    ADD CONSTRAINT studio_account_machine_bindings_pkey PRIMARY KEY (account_machine_id, project_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_pairing
    ADD CONSTRAINT studio_account_machine_pairing_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_pairing
    ADD CONSTRAINT studio_account_machine_pairing_pkey PRIMARY KEY (code_hash);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machines
    ADD CONSTRAINT studio_account_machines_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machines
    ADD CONSTRAINT studio_account_machines_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machines
    ADD CONSTRAINT studio_account_machines_token_hash_key UNIQUE (token_hash);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_jobs
    ADD CONSTRAINT studio_agent_jobs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_jobs
    ADD CONSTRAINT studio_agent_jobs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_policy
    ADD CONSTRAINT studio_agent_policy_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_policy
    ADD CONSTRAINT studio_agent_policy_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_profiles
    ADD CONSTRAINT studio_agent_profiles_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_profiles
    ADD CONSTRAINT studio_agent_profiles_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_schedule
    ADD CONSTRAINT studio_agent_schedule_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_schedule
    ADD CONSTRAINT studio_agent_schedule_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_audio_staging
    ADD CONSTRAINT studio_audio_staging_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_audio_staging
    ADD CONSTRAINT studio_audio_staging_pkey PRIMARY KEY (object_key);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_cards
    ADD CONSTRAINT studio_conversation_cards_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_cards
    ADD CONSTRAINT studio_conversation_cards_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_snapshots
    ADD CONSTRAINT studio_conversation_snapshots_artifact_id_thread_id_source__key UNIQUE (artifact_id, thread_id, source_hash);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_snapshots
    ADD CONSTRAINT studio_conversation_snapshots_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_snapshots
    ADD CONSTRAINT studio_conversation_snapshots_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_admissions
    ADD CONSTRAINT studio_decision_admissions_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_admissions
    ADD CONSTRAINT studio_decision_admissions_pkey PRIMARY KEY (call_id, fence);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_calls
    ADD CONSTRAINT studio_decision_calls_idempotency_key_key UNIQUE (idempotency_key);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_calls
    ADD CONSTRAINT studio_decision_calls_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_calls
    ADD CONSTRAINT studio_decision_calls_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_profiles
    ADD CONSTRAINT studio_decision_profiles_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_profiles
    ADD CONSTRAINT studio_decision_profiles_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_flows
    ADD CONSTRAINT studio_design_flows_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_flows
    ADD CONSTRAINT studio_design_flows_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_review_requests
    ADD CONSTRAINT studio_design_review_requests_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_review_requests
    ADD CONSTRAINT studio_design_review_requests_pkey PRIMARY KEY (artifact_id, user_id, request_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_durable_jobs
    ADD CONSTRAINT studio_durable_jobs_idempotency_key_key UNIQUE (idempotency_key);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_durable_jobs
    ADD CONSTRAINT studio_durable_jobs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_durable_jobs
    ADD CONSTRAINT studio_durable_jobs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_implementation_machine_queue
    ADD CONSTRAINT studio_implementation_machine_queue_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_implementation_machine_queue
    ADD CONSTRAINT studio_implementation_machine_queue_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_checkouts
    ADD CONSTRAINT studio_investigation_checkouts_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_checkouts
    ADD CONSTRAINT studio_investigation_checkouts_pkey PRIMARY KEY (machine_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_consent
    ADD CONSTRAINT studio_investigation_consent_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_consent
    ADD CONSTRAINT studio_investigation_consent_pkey PRIMARY KEY (machine_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_decisions
    ADD CONSTRAINT studio_investigation_decisions_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_decisions
    ADD CONSTRAINT studio_investigation_decisions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_images
    ADD CONSTRAINT studio_investigation_images_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_images
    ADD CONSTRAINT studio_investigation_images_pkey PRIMARY KEY (file_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_passages
    ADD CONSTRAINT studio_investigation_passages_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_passages
    ADD CONSTRAINT studio_investigation_passages_pkey PRIMARY KEY (artifact_id, user_id, digest);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_selections
    ADD CONSTRAINT studio_investigation_selections_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_selections
    ADD CONSTRAINT studio_investigation_selections_pkey PRIMARY KEY (investigation_id, view_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations
    ADD CONSTRAINT studio_investigations_child_artifact_id_key UNIQUE (child_artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations
    ADD CONSTRAINT studio_investigations_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations
    ADD CONSTRAINT studio_investigations_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_outbox
    ADD CONSTRAINT studio_job_outbox_intent_key_key UNIQUE (intent_key);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_outbox
    ADD CONSTRAINT studio_job_outbox_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_outbox
    ADD CONSTRAINT studio_job_outbox_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_receipts
    ADD CONSTRAINT studio_job_receipts_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_receipts
    ADD CONSTRAINT studio_job_receipts_pkey PRIMARY KEY (job_id, name, phase);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_pairing
    ADD CONSTRAINT studio_machine_pairing_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_pairing
    ADD CONSTRAINT studio_machine_pairing_pkey PRIMARY KEY (code_hash);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_work
    ADD CONSTRAINT studio_machine_work_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_work
    ADD CONSTRAINT studio_machine_work_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machines
    ADD CONSTRAINT studio_machines_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machines
    ADD CONSTRAINT studio_machines_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machines
    ADD CONSTRAINT studio_machines_token_hash_key UNIQUE (token_hash);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_planner_owners
    ADD CONSTRAINT studio_planner_owners_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_planner_owners
    ADD CONSTRAINT studio_planner_owners_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_realtime_clock
    ADD CONSTRAINT studio_realtime_clock_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_realtime_clock
    ADD CONSTRAINT studio_realtime_clock_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_realtime_events
    ADD CONSTRAINT studio_realtime_events_id_key UNIQUE (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_realtime_events
    ADD CONSTRAINT studio_realtime_events_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_realtime_events
    ADD CONSTRAINT studio_realtime_events_pkey PRIMARY KEY (sequence);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_baselines
    ADD CONSTRAINT studio_rebuild_baselines_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_baselines
    ADD CONSTRAINT studio_rebuild_baselines_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_consent
    ADD CONSTRAINT studio_rebuild_consent_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_consent
    ADD CONSTRAINT studio_rebuild_consent_pkey PRIMARY KEY (machine_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_execution_receipts
    ADD CONSTRAINT studio_rebuild_execution_receipts_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_execution_receipts
    ADD CONSTRAINT studio_rebuild_execution_receipts_pkey PRIMARY KEY (rebuild_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_pending
    ADD CONSTRAINT studio_rebuild_pending_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_pending
    ADD CONSTRAINT studio_rebuild_pending_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_runs
    ADD CONSTRAINT studio_rebuild_runs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_runs
    ADD CONSTRAINT studio_rebuild_runs_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_jobs
    ADD CONSTRAINT studio_runner_jobs_job_id_key UNIQUE (job_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_jobs
    ADD CONSTRAINT studio_runner_jobs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_jobs
    ADD CONSTRAINT studio_runner_jobs_pkey PRIMARY KEY (run_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_workspaces
    ADD CONSTRAINT studio_runner_workspaces_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_workspaces
    ADD CONSTRAINT studio_runner_workspaces_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_schema
    ADD CONSTRAINT studio_schema_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_schema
    ADD CONSTRAINT studio_schema_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_candidates
    ADD CONSTRAINT studio_spike_candidates_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_candidates
    ADD CONSTRAINT studio_spike_candidates_pkey PRIMARY KEY (artifact_id, user_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_checks
    ADD CONSTRAINT studio_spike_checks_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_checks
    ADD CONSTRAINT studio_spike_checks_pkey PRIMARY KEY (artifact_id, user_id, source_version);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_title_state
    ADD CONSTRAINT studio_title_state_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_title_state
    ADD CONSTRAINT studio_title_state_pkey PRIMARY KEY (artifact_id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_video_staging
    ADD CONSTRAINT studio_video_staging_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_video_staging
    ADD CONSTRAINT studio_video_staging_pkey PRIMARY KEY (object_key);



ALTER TABLE ONLY release_smoke_20261030_0236.threads
    ADD CONSTRAINT threads_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.users
    ADD CONSTRAINT users_email_key UNIQUE (email);



ALTER TABLE ONLY release_smoke_20261030_0236.users
    ADD CONSTRAINT users_oidc_sub_key UNIQUE (oidc_sub);



ALTER TABLE ONLY release_smoke_20261030_0236.users
    ADD CONSTRAINT users_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);



ALTER TABLE ONLY release_smoke_20261030_0236.video_render_jobs
    ADD CONSTRAINT video_render_jobs_ordinal_key UNIQUE (ordinal);



ALTER TABLE ONLY release_smoke_20261030_0236.video_render_jobs
    ADD CONSTRAINT video_render_jobs_pkey PRIMARY KEY (id);



CREATE INDEX artifacts_project ON release_smoke_20261030_0236.artifacts USING btree (project_id, archived);



CREATE INDEX audio_render_artifact ON release_smoke_20261030_0236.audio_render_jobs USING btree (artifact_id, created_at);



CREATE INDEX audit_project ON release_smoke_20261030_0236.audit USING btree (project_id, id);



CREATE INDEX decisions_artifact ON release_smoke_20261030_0236.decisions USING btree (artifact_id);



CREATE INDEX document_answers_artifact ON release_smoke_20261030_0236.document_answers USING btree (artifact_id);



CREATE INDEX document_decision_anchors_artifact ON release_smoke_20261030_0236.document_decision_anchors USING btree (artifact_id);



CREATE INDEX document_suggestions_artifact ON release_smoke_20261030_0236.document_suggestions USING btree (artifact_id);



CREATE INDEX identity_challenges_expiry ON release_smoke_20261030_0236.identity_challenges USING btree (expires_at);



CREATE INDEX implementation_runs_artifact ON release_smoke_20261030_0236.implementation_runs USING btree (artifact_id, started_at);



CREATE INDEX links_artifact ON release_smoke_20261030_0236.links USING btree (artifact_id);



CREATE INDEX messages_artifact ON release_smoke_20261030_0236.messages USING btree (artifact_id);



CREATE INDEX messages_artifact_thread ON release_smoke_20261030_0236.messages USING btree (artifact_id, thread_id);



CREATE INDEX messages_thread ON release_smoke_20261030_0236.messages USING btree (thread_id, created_at);



CREATE INDEX repository_identity_lease_expiry ON release_smoke_20261030_0236.repository_identity_leases USING btree (expires_at);



CREATE INDEX runs_artifact ON release_smoke_20261030_0236.runs USING btree (artifact_id, created_at);



CREATE INDEX studio_agent_jobs_artifact ON release_smoke_20261030_0236.studio_agent_jobs USING btree (artifact_id, created_at);



CREATE INDEX studio_audio_staging_due ON release_smoke_20261030_0236.studio_audio_staging USING btree (state, next_cleanup);



CREATE INDEX studio_conversation_card_artifact ON release_smoke_20261030_0236.studio_conversation_cards USING btree (artifact_id, thread_id);



CREATE INDEX studio_decision_active ON release_smoke_20261030_0236.studio_decision_calls USING btree (status, lease_expires, user_id, project_id);



CREATE INDEX studio_decision_admission_project ON release_smoke_20261030_0236.studio_decision_admissions USING btree (project_id, admitted_at);



CREATE INDEX studio_decision_admission_user ON release_smoke_20261030_0236.studio_decision_admissions USING btree (user_id, admitted_at);



CREATE INDEX studio_decision_cache ON release_smoke_20261030_0236.studio_decision_calls USING btree (project_id, artifact_id, user_id, request_hash, status, created_at);



CREATE INDEX studio_design_flows_artifact ON release_smoke_20261030_0236.studio_design_flows USING btree (artifact_id, created_at);



CREATE INDEX studio_durable_artifact ON release_smoke_20261030_0236.studio_durable_jobs USING btree (artifact_id, created_at);



CREATE INDEX studio_durable_due ON release_smoke_20261030_0236.studio_durable_jobs USING btree (status, available_at, lease_expires);



CREATE INDEX studio_implementation_machine_active ON release_smoke_20261030_0236.studio_implementation_machine_queue USING btree (artifact_id, status);



CREATE INDEX studio_implementation_machine_owner ON release_smoke_20261030_0236.studio_implementation_machine_queue USING btree (machine_id, user_id, status);



CREATE INDEX studio_investigations_queue ON release_smoke_20261030_0236.studio_investigations USING btree (project_id, user_id, status, created_at);



CREATE INDEX studio_job_outbox_due ON release_smoke_20261030_0236.studio_job_outbox USING btree (status, retry_at, dispatch_expires);



CREATE INDEX studio_machine_work_project ON release_smoke_20261030_0236.studio_machine_work USING btree (project_id, status, created_at);



CREATE INDEX studio_realtime_topic ON release_smoke_20261030_0236.studio_realtime_events USING btree (topic, sequence);



CREATE INDEX studio_rebuild_active ON release_smoke_20261030_0236.studio_rebuild_runs USING btree (artifact_id, status);



CREATE INDEX studio_rebuild_machine ON release_smoke_20261030_0236.studio_rebuild_runs USING btree (machine_id, status);



CREATE INDEX studio_video_staging_due ON release_smoke_20261030_0236.studio_video_staging USING btree (state, next_cleanup);



CREATE INDEX threads_artifact ON release_smoke_20261030_0236.threads USING btree (artifact_id);



CREATE INDEX video_render_artifact ON release_smoke_20261030_0236.video_render_jobs USING btree (artifact_id, created_at);



ALTER TABLE ONLY release_smoke_20261030_0236.artifacts
    ADD CONSTRAINT artifacts_created_by_fkey FOREIGN KEY (created_by) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.artifacts
    ADD CONSTRAINT artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.audio_render_jobs
    ADD CONSTRAINT audio_render_jobs_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.audio_render_jobs
    ADD CONSTRAINT audio_render_jobs_file_id_fkey FOREIGN KEY (file_id) REFERENCES release_smoke_20261030_0236.files(id);



ALTER TABLE ONLY release_smoke_20261030_0236.audio_render_jobs
    ADD CONSTRAINT audio_render_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.audit
    ADD CONSTRAINT audit_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.audit
    ADD CONSTRAINT audit_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.decisions
    ADD CONSTRAINT decisions_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.document_answers
    ADD CONSTRAINT document_answers_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.document_answers
    ADD CONSTRAINT document_answers_author_id_fkey FOREIGN KEY (author_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.document_answers
    ADD CONSTRAINT document_answers_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES release_smoke_20261030_0236.decisions(id) ON DELETE SET NULL;



ALTER TABLE ONLY release_smoke_20261030_0236.document_answers
    ADD CONSTRAINT document_answers_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.document_answers
    ADD CONSTRAINT document_answers_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES release_smoke_20261030_0236.document_answers(id) ON DELETE SET NULL;



ALTER TABLE ONLY release_smoke_20261030_0236.document_decision_anchors
    ADD CONSTRAINT document_decision_anchors_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.document_decision_anchors
    ADD CONSTRAINT document_decision_anchors_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES release_smoke_20261030_0236.decisions(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.document_decision_anchors
    ADD CONSTRAINT document_decision_anchors_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.document_suggestions
    ADD CONSTRAINT document_suggestions_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.document_suggestions
    ADD CONSTRAINT document_suggestions_author_id_fkey FOREIGN KEY (author_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.document_suggestions
    ADD CONSTRAINT document_suggestions_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.files
    ADD CONSTRAINT files_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.files
    ADD CONSTRAINT files_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_commands
    ADD CONSTRAINT implementation_commands_run_id_fkey FOREIGN KEY (run_id) REFERENCES release_smoke_20261030_0236.implementation_runs(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_draft_requests
    ADD CONSTRAINT implementation_draft_requests_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_draft_requests
    ADD CONSTRAINT implementation_draft_requests_job_id_fkey FOREIGN KEY (job_id) REFERENCES release_smoke_20261030_0236.studio_durable_jobs(id);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_draft_requests
    ADD CONSTRAINT implementation_draft_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_events
    ADD CONSTRAINT implementation_events_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_graphs
    ADD CONSTRAINT implementation_graphs_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_heads
    ADD CONSTRAINT implementation_heads_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.implementation_runs
    ADD CONSTRAINT implementation_runs_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.links
    ADD CONSTRAINT links_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.memberships
    ADD CONSTRAINT memberships_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.messages
    ADD CONSTRAINT messages_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.messages
    ADD CONSTRAINT messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.messages
    ADD CONSTRAINT messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES release_smoke_20261030_0236.threads(id);



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identities
    ADD CONSTRAINT repository_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identity_epochs
    ADD CONSTRAINT repository_identity_epochs_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.repository_identity_leases
    ADD CONSTRAINT repository_identity_leases_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.repository_identities(user_id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.revisions
    ADD CONSTRAINT revisions_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.runs
    ADD CONSTRAINT runs_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_bindings
    ADD CONSTRAINT studio_account_machine_bindings_account_machine_id_fkey FOREIGN KEY (account_machine_id) REFERENCES release_smoke_20261030_0236.studio_account_machines(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_bindings
    ADD CONSTRAINT studio_account_machine_bindings_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machine_pairing
    ADD CONSTRAINT studio_account_machine_pairing_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_account_machines
    ADD CONSTRAINT studio_account_machines_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_jobs
    ADD CONSTRAINT studio_agent_jobs_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_jobs
    ADD CONSTRAINT studio_agent_jobs_child_artifact_id_fkey FOREIGN KEY (child_artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE SET NULL;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_jobs
    ADD CONSTRAINT studio_agent_jobs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES release_smoke_20261030_0236.threads(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_jobs
    ADD CONSTRAINT studio_agent_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_policy
    ADD CONSTRAINT studio_agent_policy_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_profiles
    ADD CONSTRAINT studio_agent_profiles_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_profiles
    ADD CONSTRAINT studio_agent_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_schedule
    ADD CONSTRAINT studio_agent_schedule_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_agent_schedule
    ADD CONSTRAINT studio_agent_schedule_job_id_fkey FOREIGN KEY (job_id) REFERENCES release_smoke_20261030_0236.studio_durable_jobs(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_audio_staging
    ADD CONSTRAINT studio_audio_staging_job_id_fkey FOREIGN KEY (job_id) REFERENCES release_smoke_20261030_0236.studio_durable_jobs(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_cards
    ADD CONSTRAINT studio_conversation_cards_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_cards
    ADD CONSTRAINT studio_conversation_cards_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_cards
    ADD CONSTRAINT studio_conversation_cards_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES release_smoke_20261030_0236.studio_conversation_snapshots(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_cards
    ADD CONSTRAINT studio_conversation_cards_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES release_smoke_20261030_0236.threads(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_snapshots
    ADD CONSTRAINT studio_conversation_snapshots_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_snapshots
    ADD CONSTRAINT studio_conversation_snapshots_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_snapshots
    ADD CONSTRAINT studio_conversation_snapshots_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_conversation_snapshots
    ADD CONSTRAINT studio_conversation_snapshots_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES release_smoke_20261030_0236.threads(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_admissions
    ADD CONSTRAINT studio_decision_admissions_call_id_fkey FOREIGN KEY (call_id) REFERENCES release_smoke_20261030_0236.studio_decision_calls(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_admissions
    ADD CONSTRAINT studio_decision_admissions_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_admissions
    ADD CONSTRAINT studio_decision_admissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_calls
    ADD CONSTRAINT studio_decision_calls_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_calls
    ADD CONSTRAINT studio_decision_calls_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_calls
    ADD CONSTRAINT studio_decision_calls_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_profiles
    ADD CONSTRAINT studio_decision_profiles_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_decision_profiles
    ADD CONSTRAINT studio_decision_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_flows
    ADD CONSTRAINT studio_design_flows_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_flows
    ADD CONSTRAINT studio_design_flows_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_review_requests
    ADD CONSTRAINT studio_design_review_requests_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_review_requests
    ADD CONSTRAINT studio_design_review_requests_job_id_fkey FOREIGN KEY (job_id) REFERENCES release_smoke_20261030_0236.studio_durable_jobs(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_design_review_requests
    ADD CONSTRAINT studio_design_review_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_durable_jobs
    ADD CONSTRAINT studio_durable_jobs_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_durable_jobs
    ADD CONSTRAINT studio_durable_jobs_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_durable_jobs
    ADD CONSTRAINT studio_durable_jobs_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_implementation_machine_queue
    ADD CONSTRAINT studio_implementation_machine_queue_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_implementation_machine_queue
    ADD CONSTRAINT studio_implementation_machine_queue_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_implementation_machine_queue
    ADD CONSTRAINT studio_implementation_machine_queue_run_id_fkey FOREIGN KEY (run_id) REFERENCES release_smoke_20261030_0236.implementation_runs(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_implementation_machine_queue
    ADD CONSTRAINT studio_implementation_machine_queue_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_checkouts
    ADD CONSTRAINT studio_investigation_checkouts_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES release_smoke_20261030_0236.studio_machines(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_consent
    ADD CONSTRAINT studio_investigation_consent_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES release_smoke_20261030_0236.studio_machines(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_consent
    ADD CONSTRAINT studio_investigation_consent_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_decisions
    ADD CONSTRAINT studio_investigation_decisions_author_id_fkey FOREIGN KEY (author_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_decisions
    ADD CONSTRAINT studio_investigation_decisions_investigation_id_fkey FOREIGN KEY (investigation_id) REFERENCES release_smoke_20261030_0236.studio_investigations(id) ON DELETE RESTRICT;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_images
    ADD CONSTRAINT studio_investigation_images_file_id_fkey FOREIGN KEY (file_id) REFERENCES release_smoke_20261030_0236.files(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_images
    ADD CONSTRAINT studio_investigation_images_investigation_id_fkey FOREIGN KEY (investigation_id) REFERENCES release_smoke_20261030_0236.studio_investigations(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_passages
    ADD CONSTRAINT studio_investigation_passages_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_passages
    ADD CONSTRAINT studio_investigation_passages_investigation_id_fkey FOREIGN KEY (investigation_id) REFERENCES release_smoke_20261030_0236.studio_investigations(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_passages
    ADD CONSTRAINT studio_investigation_passages_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigation_selections
    ADD CONSTRAINT studio_investigation_selections_investigation_id_fkey FOREIGN KEY (investigation_id) REFERENCES release_smoke_20261030_0236.studio_investigations(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations
    ADD CONSTRAINT studio_investigations_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE RESTRICT;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations
    ADD CONSTRAINT studio_investigations_child_artifact_id_fkey FOREIGN KEY (child_artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE RESTRICT;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations
    ADD CONSTRAINT studio_investigations_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES release_smoke_20261030_0236.studio_machines(id) ON DELETE SET NULL;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations
    ADD CONSTRAINT studio_investigations_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_investigations
    ADD CONSTRAINT studio_investigations_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_outbox
    ADD CONSTRAINT studio_job_outbox_job_id_fkey FOREIGN KEY (job_id) REFERENCES release_smoke_20261030_0236.studio_durable_jobs(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_job_receipts
    ADD CONSTRAINT studio_job_receipts_job_id_fkey FOREIGN KEY (job_id) REFERENCES release_smoke_20261030_0236.studio_durable_jobs(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_pairing
    ADD CONSTRAINT studio_machine_pairing_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_pairing
    ADD CONSTRAINT studio_machine_pairing_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_work
    ADD CONSTRAINT studio_machine_work_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_work
    ADD CONSTRAINT studio_machine_work_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES release_smoke_20261030_0236.studio_machines(id) ON DELETE SET NULL;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_work
    ADD CONSTRAINT studio_machine_work_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machine_work
    ADD CONSTRAINT studio_machine_work_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machines
    ADD CONSTRAINT studio_machines_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_machines
    ADD CONSTRAINT studio_machines_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_planner_owners
    ADD CONSTRAINT studio_planner_owners_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_planner_owners
    ADD CONSTRAINT studio_planner_owners_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_baselines
    ADD CONSTRAINT studio_rebuild_baselines_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_baselines
    ADD CONSTRAINT studio_rebuild_baselines_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_baselines
    ADD CONSTRAINT studio_rebuild_baselines_run_id_fkey FOREIGN KEY (run_id) REFERENCES release_smoke_20261030_0236.implementation_runs(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_baselines
    ADD CONSTRAINT studio_rebuild_baselines_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_consent
    ADD CONSTRAINT studio_rebuild_consent_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES release_smoke_20261030_0236.studio_machines(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_consent
    ADD CONSTRAINT studio_rebuild_consent_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_execution_receipts
    ADD CONSTRAINT studio_rebuild_execution_receipts_rebuild_id_fkey FOREIGN KEY (rebuild_id) REFERENCES release_smoke_20261030_0236.studio_rebuild_runs(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_pending
    ADD CONSTRAINT studio_rebuild_pending_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_pending
    ADD CONSTRAINT studio_rebuild_pending_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_pending
    ADD CONSTRAINT studio_rebuild_pending_writer_id_fkey FOREIGN KEY (writer_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_runs
    ADD CONSTRAINT studio_rebuild_runs_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_runs
    ADD CONSTRAINT studio_rebuild_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES release_smoke_20261030_0236.projects(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_rebuild_runs
    ADD CONSTRAINT studio_rebuild_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_jobs
    ADD CONSTRAINT studio_runner_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES release_smoke_20261030_0236.runs(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_runner_workspaces
    ADD CONSTRAINT studio_runner_workspaces_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_candidates
    ADD CONSTRAINT studio_spike_candidates_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_candidates
    ADD CONSTRAINT studio_spike_candidates_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_checks
    ADD CONSTRAINT studio_spike_checks_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_spike_checks
    ADD CONSTRAINT studio_spike_checks_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);



ALTER TABLE ONLY release_smoke_20261030_0236.studio_title_state
    ADD CONSTRAINT studio_title_state_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.studio_video_staging
    ADD CONSTRAINT studio_video_staging_job_id_fkey FOREIGN KEY (job_id) REFERENCES release_smoke_20261030_0236.studio_durable_jobs(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.threads
    ADD CONSTRAINT threads_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.video_render_jobs
    ADD CONSTRAINT video_render_jobs_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES release_smoke_20261030_0236.artifacts(id) ON DELETE CASCADE;



ALTER TABLE ONLY release_smoke_20261030_0236.video_render_jobs
    ADD CONSTRAINT video_render_jobs_file_id_fkey FOREIGN KEY (file_id) REFERENCES release_smoke_20261030_0236.files(id);



ALTER TABLE ONLY release_smoke_20261030_0236.video_render_jobs
    ADD CONSTRAINT video_render_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES release_smoke_20261030_0236.users(id);




