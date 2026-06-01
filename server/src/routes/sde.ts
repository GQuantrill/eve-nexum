import { Router } from 'express';
import { config } from '../config.js';
import { getInstalledSde, fetchLatestSdeBuild, getLastSdeCheck } from '../services/sdeUpdate.js';

// Public, browser-callable: report the EVE Static Data Export (SDE) build this
// instance is running vs. the latest CCP currently offers. No auth — the SDE
// version isn't sensitive — and the remote check is cached in the service so
// this can't be used to hammer CCP.
const router = Router();

// GET /api/sde/version
router.get('/version', async (_req, res) => {
  const [installed, latest] = await Promise.all([getInstalledSde(), fetchLatestSdeBuild()]);
  const lastCheck = getLastSdeCheck();

  // upToDate is null ("unknown") when we couldn't determine either build —
  // e.g. CCP unreachable, or a never-seeded DB — rather than a misleading false.
  const upToDate = installed.version != null && latest.build != null
    ? installed.version === latest.build
    : null;

  res.json({
    installed:   installed.version,             // build running now, e.g. "3365090" (null if never seeded)
    installedAt: installed.updatedAt,           // when that build was imported (ISO)
    latest:      latest.build,                  // latest build CCP offers (null if unreachable)
    latestCheckedAt: new Date(latest.at).toISOString(), // when THIS endpoint last queried CCP (cached)
    upToDate,                                   // true | false | null (unknown)
    autoUpdate:  config.sdeAutoUpdate,          // whether the daily auto-update is on
    // When the auto-updater itself last ran, and its outcome — distinct from
    // latestCheckedAt above. null until the first check fires this process.
    autoCheck: lastCheck
      ? { at: new Date(lastCheck.at).toISOString(), result: lastCheck.result }
      : null,
  });
});

export const sdeRouter = router;
