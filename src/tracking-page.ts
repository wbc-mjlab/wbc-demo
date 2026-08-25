/**
 * Tracking / reference mode — clip-only live demo (shareable URL).
 *
 * Opens at `/tracking.html` with Generator off so the policy tracks the selected
 * reference trajectory. Same engine as the main demo; no Gen teleop chrome.
 * Query: `?id=<policy>&clip=<clip>&chrome=minimal|full`.
 */

import { bootDemoPage } from './live-demo';

bootDemoPage({ kind: 'tracking' });
