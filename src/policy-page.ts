/**
 * Live demo page — full-screen interactive view (site landing + deep links).
 *
 * Opens at `/` with the default live policy (Generator on when Gen assets exist),
 * or reads `?id=<policy>&clip=<clip>` from the URL. Back arrow → clip gallery.
 * Use `?chrome=minimal|full` to force compact / dense HUD.
 */

import { bootDemoPage } from './live-demo';

bootDemoPage({ kind: 'live' });
