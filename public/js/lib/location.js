/** Best-effort GPS fix; never rejects — missing API / denial / timeout → null. */
export function getLocationFix(timeoutMs = 8000) {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        try {
            navigator.geolocation.getCurrentPosition((position) => {
                resolve({
                    lat: Math.round(position.coords.latitude * 1e5) / 1e5,
                    lng: Math.round(position.coords.longitude * 1e5) / 1e5,
                    accuracyM: Math.round(position.coords.accuracy),
                });
            }, () => resolve(null), {
                enableHighAccuracy: false,
                maximumAge: 60_000,
                timeout: timeoutMs,
            });
        }
        catch {
            resolve(null);
        }
    });
}
