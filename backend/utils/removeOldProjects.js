/// for some reason this causes a ton of issues :/

import { livescratchPath, scratchprojectsPath } from './fileStorage.js';
import fsp from 'node:fs/promises';
import cron from 'node-cron';

function sleep(millis) {
    return new Promise(res => setTimeout(res, millis));
}

let inprog=false;
export function installCleaningJob(sessionManager, userManager) {
    // removeOldProjectsAsync(sessionManager, userManager);
    // removeUntetheredScratchprojects(sessionManager,userManager)
    cron.schedule(CRON_EXPRESSION, async () => {
        if(inprog) {return;} // dont do it twice
        inprog=true;
        try {
            await removeOldProjectsAsync(sessionManager, userManager);
            await removeUntetheredScratchprojects(sessionManager,userManager);
        } catch (error) { console.error('Project cleanup failed:', error); }
        finally { inprog=false; }
    },{
        scheduled: true,
        timezone: 'Asia/Qatar',
    });
}

const HOW_OLD_DAYS = 60; // delete projects with no new edits in the last this number of days
const CRON_EXPRESSION = '0 2 * * *'; // every night at 2am

async function removeOldProjectsAsync(sessionManager, userManager) {
    const files = (await fsp.readdir(livescratchPath)).filter(name => /^\d+$/.test(name));
    console.log('removal test started', files);
    for (let id of files) {
        await sleep(55); // rate limit might fix issues??????? IM LOSSTTTTTTTT!!!
        try {

            console.log('probing project with id ' + id);
            let project = sessionManager.getProject(id);
            if (!project) {
                console.log('project doesnt exist, DELETING id ' + id);
                // A read error is not proof that the project should be deleted.
            } //todo check if project not existing messes up delete function
            else { // if project does exist
                id = project.id; // since we know that project.id exists

                if (Object.keys(project.session.connectedClients).length == 0) {
                    if (project.project.lastTime && Date.now() - new Date(project.project.lastTime) > HOW_OLD_DAYS * 24 * 60 * 60 * 1000) {

                        console.log(`deleting project ${id} because it is old`);

                        [project.owner, ...project.sharedWith].forEach(username => {
                            userManager.unShare(username, id);
                            sessionManager.unshareProject(id, username);
                        });

                        sessionManager.deleteProjectFile(id);
                    } else {
                        project.trimChanges();
                        await sessionManager.offloadProjectAsync(id);
                    }
                }
            }
        }
        catch (e) {
            console.error(`error while probing project ${id}:`, e);
        }
    }
}


async function removeUntetheredScratchprojects(sessionManager, userManager) {

    const files = await fsp.readdir(scratchprojectsPath);
    console.log('removal scratchprojectsentries test started', files);
    for (let scratchid of files) {

        await sleep(60);
        let entry = sessionManager.getScratchProjectEntry(scratchid);
        if(!entry) {
            console.warn(`Unreadable Scratch project link retained: ${scratchid}`);
            continue;
        }
        let id = entry.lsId;
        let project = sessionManager.getProject(id);
        if (!project) {
            console.warn(`Missing project for Scratch link retained: ${scratchid}`);
            continue;
        }
    }
    return;
}
