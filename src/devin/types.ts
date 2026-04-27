/**
 * Subset of Devin v1 session shapes the gateway cares about. We keep the
 * structure permissive (most fields optional / unknown) because the upstream
 * API surface is wider than what we need.
 */
export interface DevinSessionMessage {
  type?: string;
  origin?: string;
  author?: string;
  role?: string;
  message?: string;
  content?: string;
  text?: string;
  // Allow any additional fields without breaking type-checking.
  [key: string]: unknown;
}

export interface DevinSession {
  session_id?: string;
  status?: string;
  status_enum?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  messages?: DevinSessionMessage[];
  structured_output?: unknown;
  title?: string;
  pull_request?: { url?: string } | null;
  [key: string]: unknown;
}

export interface DevinCreateSessionResponse {
  session_id: string;
  url?: string;
  is_new_session?: boolean;
  [key: string]: unknown;
}
