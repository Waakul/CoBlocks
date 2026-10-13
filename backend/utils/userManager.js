// user:
//  friends LIST of STRING
//  projects owned by user LIST of 
//  projects shared to user LIST
//     > livescratch id
//     > from user
//  scratch id (pk- "primary key")
//

import sanitize from 'sanitize-filename';
import { saveMapToFolder, usersPath } from './fileStorage.js';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'node:crypto';

const OFFLOAD_TIMEOUT_MILLIS = 30 * 1000;

export default class UserManager {

    // removed since dynamic reloading/offloading
    // static fromJSON(json) {
    //     let thing = new UserManager()
    //     thing.users = json.users
    //     return thing
    // }

    users = {};

    verify(username, token) {
        return !!token && this.findUser(username)?.token === token;
    }

    befriend(base, to) {
        console.log(base + ' friending ' + to);
        const friends = this.getUser(base)?.friends;
        const friend = to?.toLowerCase();
        if (friends && friend && !friends.includes(friend)) friends.push(friend);
    }
    unbefriend(base, take) {
        console.log(base + ' unfriending ' + take);
        take = take?.toLowerCase();
        const friends = this.getUser(base)?.friends;
        const index = friends?.indexOf(take) ?? -1;
        if (index !== -1) friends.splice(index, 1);
    }

    userExists(username) {
        this.reloadUser(username);
        return (username?.toLowerCase?.() in this.users);
    }

    getUser(username) {
        if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return null;
        username = username.toLowerCase();

        // clear previous timeout
        clearTimeout(this.offloadTimeoutIds[username]);
        delete this.offloadTimeoutIds[username];
        // set new timeout
        let timeout = setTimeout(() => { this.offloadUser(username); }, OFFLOAD_TIMEOUT_MILLIS);
        this.offloadTimeoutIds[username] = timeout;


        this.reloadUser(username);
        if (!(username?.toLowerCase() in this.users)) {
            this.addUser(username);
        }
        return this.users[username.toLowerCase()]; // 🟢
    }

    findUser(username) {
        if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return null;
        this.reloadUser(username);
        return this.users[username.toLowerCase()] || null;
    }

    addUser(username) {
        this.reloadUser(username);
        if (!(username?.toLowerCase() in this.users)) {
            this.users[username.toLowerCase()] = { username, friends: [], token: this.token(), sharedTo: {}, myProjects: [], verified:false, privateMe: false }; // 🚨
        }
        return this.getUser(username);
    }

    offloadTimeoutIds = {};

    reloadUser(username) {
        if (!username?.toLowerCase) { console.error(`username is not string ${username}`); console.trace(); return; } // username is not a string
        username = username.toLowerCase();

        if (!(username in this.users)) {
            // console.log(`reloading user ${username}`)

            let usernameFile = sanitize(username + '');
            if (!usernameFile) { return; } // dont do anything if username doesnt exist

            let filename = usersPath + path.sep + usernameFile;

            if (!fs.existsSync(filename)) { return; }

            try {
                let json = fs.readFileSync(filename);
                let user = JSON.parse(json);
                this.users[username] = user;
            } catch (error) {
                console.error(`Could not load user ${username}:`, error);
                throw error;
            }


        }
    }
    offloadUser(username) {
        // console.log(`offloading user ${username}`)
        if (!username?.toLowerCase) { console.error(`username is not string ${username}`); console.trace(); return; } // username is not a string
        username = username.toLowerCase();
        if (!(username in this.users)) { return; }
        let usersSave = {};
        usersSave[username] = this.users[username]; // get user object to save
        if (saveMapToFolder(usersSave, usersPath)) delete this.users[username];
    }

    persistUser(username) {
        const user = this.findUser(username);
        return !!user && saveMapToFolder({ [username.toLowerCase()]: user }, usersPath);
    }

    newProject(owner, lsId) {
        console.log(`usrMngr: adding new project ${lsId} owned by ${owner}`);
        if (this.getUser(owner).myProjects.indexOf(lsId) != -1) { return; }
        this.getUser(owner).myProjects.push(lsId);
    }

    share(username, lsId, from) {
        from = from?.toLowerCase();
        console.log(`usrMngr: sharing ${lsId} with ${username} from ${from}`);
        let map = this.getUser(username)?.sharedTo;
        if (!map) { return; }
        if (lsId in map) { return; }
        map[lsId] = { from, id: lsId };
    }
    unShare(username, lsId) {
        username = username?.toLowerCase();
        console.log(`usrMngr: unsharing ${lsId} with ${username}`);
        let map = this.getUser(username)?.sharedTo;
        if (!map) { return; }
        delete map[lsId];

        let ownedIndex = this.getUser(username)?.myProjects.indexOf(lsId);
        if (ownedIndex != -1) {
            this.getUser(username)?.myProjects.splice(ownedIndex, 1);
        }



    }
    getSharedObjects(username) {
        return Object.values(this.getUser(username)?.sharedTo);
    }
    getShared(username) {
        let user = this.getUser(username);
        let objs = this.getSharedObjects(username);
        if (!objs) { return []; }
        return objs.filter((proj) => (user.friends.indexOf(proj.from?.toLowerCase()) != -1)).map((proj) => (proj.id));
    }
    getAllProjects(username) {
        return this.getUser(username).myProjects.concat(this.getShared(username));
    }

    rand() {
        return Math.random().toString(36).substring(2); // remove `0.`
    };

    token() {
        return randomBytes(32).toString('hex');
    };
}
