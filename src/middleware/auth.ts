import type { Request, Response, NextFunction, RequestHandler } from "express";
import { unauthorized } from "../utils/errors.js";

/**
 * Bearer-token middleware. If `expectedKey` is empty the middleware becomes a
 * no-op (auth disabled). Otherwise the request must carry
 * `Authorization: Bearer <expectedKey>`.
 */
export function bearerAuth(expectedKey: string): RequestHandler {
  if (!expectedKey) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1].trim() !== expectedKey) {
      const err = unauthorized();
      res.status(err.status).json(err.toBody());
      return;
    }
    next();
  };
}
