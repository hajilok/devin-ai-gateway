/**
 * OpenAI-style error envelope. We reuse the same shape so existing clients can
 * surface meaningful messages without custom handling.
 */
export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string;
  };
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly type: string;
  public readonly code?: string;

  constructor(status: number, message: string, type = "api_error", code?: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }

  toBody(): OpenAIErrorBody {
    const body: OpenAIErrorBody = {
      error: { message: this.message, type: this.type },
    };
    if (this.code) body.error.code = this.code;
    return body;
  }
}

export function badRequest(message: string, code?: string): HttpError {
  return new HttpError(400, message, "invalid_request_error", code);
}

export function unauthorized(message = "Missing or invalid API key."): HttpError {
  return new HttpError(401, message, "invalid_request_error", "invalid_api_key");
}

export function upstreamError(message: string, status = 502): HttpError {
  return new HttpError(status, message, "upstream_error");
}

export function timeoutError(message: string): HttpError {
  return new HttpError(504, message, "timeout");
}
