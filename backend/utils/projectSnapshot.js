export function normalizeScratchProjectJson(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch { return null; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.targets)) return null;
    if (!parsed.targets.every(target => target && typeof target === 'object' && typeof target.isStage === 'boolean')) return null;
    return parsed;
}

export function isScratchProjectJson(value) {
    return !!normalizeScratchProjectJson(value);
}
