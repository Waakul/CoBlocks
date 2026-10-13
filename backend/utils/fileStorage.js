import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';
import { randomUUID } from 'node:crypto';

import { saveRecent } from './recentUsers.js';
import { isFinalSaving } from '../index.js';

export const livescratchPath = 'storage/sessions/livescratch';
export const scratchprojectsPath = 'storage/sessions/scratchprojects';
export const lastIdPath = 'storage/sessions/lastId';
export const usersPath = 'storage/users';
export const bannedPath = 'storage/banned';

function sleep(millis) {
    return new Promise(res=>setTimeout(res,millis));
}

if(!fs.existsSync('storage')) {
    fs.mkdirSync('storage');
}
fs.mkdirSync('storage/sessions/scratchprojects', { recursive: true });
fs.mkdirSync('storage/sessions/livescratch', { recursive: true });

const bannedList = () => {
    try {
        const data = fs.readFileSync(bannedPath, 'utf-8');
        return data.split('\n').filter(line => line.trim() !== '');
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
};

export function saveMapToFolder(obj, dir) {
    // if obj is null, return
    if(!obj) {console.error('tried to save null object to dir: ' + dir); return false;}
    // make directory if it doesnt exist
    if (!fs.existsSync(dir)){fs.mkdirSync(dir,{recursive:true});}
    let success = true;
    Object.entries(obj).forEach(entry=>{
        let stringg = JSON.stringify(entry[1]);
        entry[0] = sanitize(entry[0] + '');
        if(entry[0] == '' || stringg.length > maxStringWriteLength) {
            console.error(`skipping writing file "${entry[0]}" because its too long or noname`);
            success = false;
            return;
        }
        let temp;
        try{
            // console.log(`writing ${entry[0]}`)
            const filename = dir + path.sep + entry[0];
            temp = `${filename}.${randomUUID()}.tmp`;
            fs.writeFileSync(temp, stringg);
            fs.renameSync(temp, filename);
        } catch (e) {
            if (temp) { try { fs.rmSync(temp); } catch { /* ignored */ } }
            success = false;
            console.error('Error when saving filename: ' + entry[0]);
            console.error(e);
        }
    });
    return success;
}

const maxStringWriteLength = 51428000; //absolute max, hopefully never reached
export async function saveMapToFolderAsync(obj, dir) {
    // if obj is null, return
    if(!obj) {console.warn('tried to save null object to dir: ' + dir); return false;}
    // make directory if it doesnt exist
    if (!fs.existsSync(dir)){fs.mkdirSync(dir,{recursive:true});}
    let success = true;
    for (let entry of Object.entries(obj)) {
        let id = sanitize(entry[0] + '');
        let stringg = JSON.stringify(entry[1]);

        if(!id || stringg.length >= maxStringWriteLength) {
            console.error(`skipping writing project ${id} because its too long or noname`);
            success = false;
            continue;
        }
        let filename = dir+path.sep+id;
        const temp = `${filename}.${randomUUID()}.tmp`;
        await fsp.writeFile(temp,stringg).then(() => fsp.rename(temp, filename)).catch(async e=>{success = false;await fsp.rm(temp, { force: true }).catch(() => {});console.error('Error when saving filename:');console.error(e);});
    }
    return success;
}
export function loadMapFromFolder(dir) {
    let obj = {};
    // check that directory exists, otherwise return empty obj
    if(!fs.existsSync(dir)) {return obj;}
    // add promises
    fs.readdirSync(dir,{withFileTypes:true})
        .filter(dirent=>dirent.isFile())
        .map(dirent=>([dirent.name,fs.readFileSync(dir + path.sep + dirent.name)]))
        .forEach(entry=>{
            try{
                obj[entry[0]] = JSON.parse(entry[1]); // parse file to object
            } catch (e) {
                console.error('json parse error on file: ' + dir + path.sep + '\x1b[1m' /* <- bold */ + entry[0] + '\x1b[0m' /* <- reset */);
                // Keep damaged data for recovery rather than deleting it during startup.
            }
        });
    return obj;
}

export function loadMapFromFolderRecursive(dir) {
    let obj = {};
 
    // Check that the directory exists; otherwise, return an empty object
    if (!fs.existsSync(dir)) {
        return obj;
    }
 
    // Read directory contents
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
 
    for (const dirent of dirents) {
        const fullPath = path.join(dir, dirent.name);
 
        if (dirent.isFile()) {
            try {
                // Parse the file's contents as JSON
                if (dirent.name=='banned') {
                    obj[dirent.name] = bannedList();
                } else {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    obj[dirent.name] = JSON.parse(content);
                }
            } catch (e) {
                console.error(
                    'JSON parse error on file: ' +
                     fullPath +
                     '\x1b[1m' + // bold text
                     dirent.name +
                     '\x1b[0m', // reset text
                );
                // Keep damaged data for recovery rather than deleting it during startup.
            }
        } else if (dirent.isDirectory()) {
            // If it's a directory, call the function recursively
            obj[dirent.name] = loadMapFromFolderRecursive(fullPath);
        }
    }
 
    return obj;
}

async function saveAsync(sessionManager) {
    if(isFinalSaving) {return;} // dont final save twice

    console.log('saving now...');
    await sleep(10); // in case there is an error that nans lastid out

    // DONT SAVE LIVESCRATCH PROJECTS BECAUSE ITS TOO COMPUTATIONALLY EXPENSIVE AND IT HAPPENS ANYWAYS ON OFFLOAD

    await saveRecent();
}
export async function saveLoop(sessionManager) {
    while(true) {
        try{ await saveAsync(sessionManager); } 
        catch (e) { console.error(e); }
        await sleep(30 * 1000);
    }
}

export function ban(username) {
    return new Promise((resolve, reject) => {
        try {
            if(!(bannedList().includes(username))) {
                fs.writeFileSync(bannedPath, (username + '\n'), { flag: 'a' });
            }
            resolve();
        } catch(err) {
            reject(err);
        }
    });
}

export function unban(username) {
    return new Promise((resolve, reject) => {
        try {
            const banned = bannedList();
            const updatedList = banned.filter(user => user !== username);
            fs.writeFileSync(bannedPath, updatedList.join('\n'), 'utf-8');
            resolve();
        } catch(err) {
            reject(err);
        }
    });
}

export function getBanned(promise = true) {
    if (!promise) {
        return bannedList();
    }
 
    return Promise.resolve(bannedList());
}
