import { Router } from 'express';
import { getDbStatus } from '../db.js';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'formai-api', db: getDbStatus() });
});
