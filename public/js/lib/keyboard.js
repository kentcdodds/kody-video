/**
 * True when a key event targets an element that handles keys itself (form
 * fields, buttons, links, …). Global shortcuts must stand down there so
 * e.g. Space activates a tab-focused button instead of starting a take.
 */
export function isInteractiveTarget(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement))
        return false;
    return (target.closest('button, a[href], input, textarea, select, summary, [contenteditable="true"]') !== null);
}
