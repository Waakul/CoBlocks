import fsp from 'node:fs/promises';
import cron from 'node-cron';

import { projectStoragePath } from './fileStorage.js';

const MAX_INACTIVE_DAYS = 60;
const MAX_INACTIVE_MS = MAX_INACTIVE_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_SCHEDULE = '0 2 * * *';

export function installCleaningJob(sessionManager, userManager) {
    let running = false;

    cron.schedule(CLEANUP_SCHEDULE, async () => {
        if (running) return;
        running = true;
        try {
            await removeOldProjects(sessionManager, userManager);
        } catch (error) {
            console.error('Project cleanup failed:', error);
        } finally {
            running = false;
        }
    }, {
        scheduled: true,
        timezone: 'Asia/Qatar',
    });
}

async function removeOldProjects(sessionManager, userManager) {
    const projectIds = (await fsp.readdir(projectStoragePath)).filter(name => /^\d+$/.test(name));

    for (const projectId of projectIds) {
        try {
            const project = sessionManager.getProject(projectId);
            if (!project) {
                console.warn(`Unreadable project retained during cleanup: ${projectId}`);
                continue;
            }
            if (Object.keys(project.session.connectedClients).length > 0) continue;

            const lastActivity = new Date(project.project.lastTime).getTime();
            const expired = Number.isFinite(lastActivity) && Date.now() - lastActivity > MAX_INACTIVE_MS;
            if (!expired) {
                project.trimChanges();
                await sessionManager.offloadProjectAsync(project.id);
                continue;
            }

            console.log(`Deleting inactive project ${project.id}.`);
            for (const username of [project.owner, ...project.sharedWith]) {
                userManager.unShare(username, project.id);
                userManager.persistUser(username);
            }
            sessionManager.deleteProjectFile(project.id);
        } catch (error) {
            console.error(`Could not clean project ${projectId}:`, error);
        }
    }
}
