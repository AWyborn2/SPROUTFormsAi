import type { Request, Response } from 'express';

/** Catches unexpected (non-validation) errors so a DB hiccup 500s instead of hanging the request. */
export function withErrorHandling(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('route error:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  };
}
