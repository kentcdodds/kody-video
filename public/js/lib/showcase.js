/**
 * This branch is the TypeScript edition of the vanilla web-components app,
 * kept online as a showcase (typescript.kody.video). Every deployment of it
 * should point visitors at the real app and at the PR where the agent
 * analyzed the experiment, so the banner shows on any non-local hostname.
 */
export const SHOWCASE_EDITION = 'TypeScript web-components edition';
export const SHOWCASE_PR_URL = 'https://github.com/kentcdodds/kody-video/pull/89';
export const SHOWCASE_PR_NUMBER = 89;
const DISMISSED_KEY = 'kody-video:showcase-banner-dismissed';
function isLocalHostname(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local');
}
export function shouldShowShowcaseBanner() {
    if (isLocalHostname(location.hostname))
        return false;
    try {
        return localStorage.getItem(DISMISSED_KEY) === null;
    }
    catch {
        return true;
    }
}
export function dismissShowcaseBanner() {
    try {
        localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    }
    catch {
        // Private mode without storage — the banner just reappears next visit.
    }
}
