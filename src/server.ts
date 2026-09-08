import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Database } from 'better-sqlite3';
import { createDb } from './db.js';
import {
  getAvailability, createHold, releaseHold, confirmCampaign,
} from './holds.js';
import type { CreateHoldParams } from './types.js';

/**
 * The app is built as a function taking a database, rather than creating
 * one itself. That lets the tests run the routes against an in-memory
 * database without starting a server or binding a port.
 */
export function createApp(db: Database): Express {
  const app = express();
  app.use(express.json());

  // Read-only. Takes no lock — a hundred traders can call this at once and
  // nothing goes wrong. Only the two write paths below can conflict.
  app.get('/availability', (req: Request, res: Response) => {
    const { store, format, cycle } = req.query;

    if (!store || !format || !cycle) {
      return res.status(400).json({
        error: {
          code: 'missing_parameters',
          message: 'store, format and cycle are all required',
        },
      });
    }

    const result = getAvailability(db, {
      storeId: store as string, formatId: format as string, cycleId: cycle as string,
    });

    if (!result) {
      return res.status(404).json({
        error: {
          code: 'unknown_store_or_format',
          message: 'No capacity record for that store and format',
        },
      });
    }

    res.json(result);
  });

  // Reserves space provisionally. This is one of the two places two traders
  // can genuinely collide.
  app.post('/holds', (req: Request, res: Response) => {
    const { campaignId, storeId, formatId, cycleId, quantity, traderId } = req.body ?? {};

    if (!campaignId || !storeId || !formatId || !cycleId || !quantity || !traderId) {
      return res.status(400).json({
        error: {
          code: 'missing_fields',
          message: 'campaignId, storeId, formatId, cycleId, quantity and traderId are required',
        },
      });
    }

    const result = createHold(db, req.body as CreateHoldParams);

    if (result.ok) return res.status(201).json(result);

    // 409 is the right status here: the request was valid, somebody just got
    // there first. This is expected behaviour at peak, not a system fault, so
    // it should not be logged or alerted on as an error.
    if (result.reason === 'insufficient_availability') {
      return res.status(409).json({
        error: {
          code: result.reason,
          message: `Only ${result.available} unit(s) free in that slot`,
          details: { requested: quantity, available: result.available },
        },
      });
    }

    res.status(404).json({
      error: { code: result.reason, message: 'Unknown store or format' },
    });
  });

  // Soft release. DELETE is right because it is idempotent — releasing twice
  // leaves the same end state.
  app.delete('/holds/:id', (req: Request, res: Response) => {
    const result = releaseHold(db, {
      holdId: Number(req.params.id),
      releasedBy: req.body?.releasedBy ?? 'unknown',
      reason: req.body?.reason,
    });

    if (result.ok) return res.status(204).end();

    res.status(409).json({
      error: {
        code: result.reason,
        message: 'That hold is not active, so it cannot be released',
      },
    });
  });

  // Partial success is normal here, so the response carries both lists rather
  // than a single status.
  //
  // Strict REST would use PATCH on the campaign resource. /confirm is an
  // action, not a noun. Most real APIs make this compromise for state
  // transitions because the intent is clearer.
  app.post('/campaigns/:id/confirm', (req: Request, res: Response) => {
    const campaignId = req.params.id;

    if (!campaignId) {
      return res.status(400).json({
        error: { code: 'missing_campaign_id', message: 'campaignId is required' },
      });
    }

    const result = confirmCampaign(db, {
      campaignId,
      confirmedBy: req.body?.confirmedBy ?? 'unknown',
      allowOversell: req.query.allowOversell === 'true',
    });

    res.json(result);
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({
      error: { code: 'internal_error', message: 'Something went wrong' },
    });
  });

  return app;
}

// Only starts a server when run directly, not when imported by tests.
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const port = process.env.PORT ?? 3000;
  createApp(createDb()).listen(port, () => {
    console.log(`smg-booking-api listening on http://localhost:${port}`);
  });
}
