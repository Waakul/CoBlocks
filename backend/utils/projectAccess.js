function normalized(value) {
    return typeof value === 'string' ? value.toLowerCase() : '';
}

export function projectAllowsUser(project, username) {
    const target = normalized(username);
    if (!project || !target) return false;
    if (normalized(project.owner) === target) return true;
    return Array.isArray(project.sharedWith) && project.sharedWith.some(name => normalized(name) === target);
}

export function userOwnsProject(project, username) {
    return !!project && normalized(project.owner) === normalized(username);
}

export function scratchLinkConflicts(existingEntry, livescratchId) {
    return !!existingEntry?.lsId && String(existingEntry.lsId) !== String(livescratchId);
}

export function reconcileProjectReferences(username, user, getProject) {
    const ownedIds = Array.isArray(user?.myProjects) ? user.myProjects.map(String) : [];
    const sharedTo = user?.sharedTo && typeof user.sharedTo === 'object' ? user.sharedTo : {};
    const friendNames = new Set((Array.isArray(user?.friends) ? user.friends : []).map(normalized));
    const visibleSharedIds = Object.values(sharedTo)
        .filter(reference => reference && friendNames.has(normalized(reference.from)))
        .map(reference => String(reference.id));
    const candidateIds = [...new Set([...ownedIds, ...visibleSharedIds])];
    const authorizedIds = [];
    const removedIds = [];

    for (const id of candidateIds) {
        const project = getProject(id);
        if (projectAllowsUser(project, username)) authorizedIds.push(id);
        else removedIds.push(id);
    }

    if (removedIds.length) {
        const removed = new Set(removedIds);
        user.myProjects = ownedIds.filter(id => !removed.has(id));
        for (const [key, reference] of Object.entries(sharedTo)) {
            if (removed.has(String(reference?.id ?? key))) delete sharedTo[key];
        }
    }

    return { authorizedIds, removedIds };
}
