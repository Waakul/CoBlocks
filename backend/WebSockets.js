import { Filter } from './utils/profanity-filter.js';
import { postText } from './utils/discord-webhook.js';
import { addRecent } from './utils/recentUsers.js';
import { authenticate, fullAuthenticate } from './utils/scratch-auth.js';
import { getBanned } from './utils/fileStorage.js';

const BROADCAST_PREFIX = 'toall ';
const admins = JSON.parse(process.env.ADMIN || '[]').map(name => String(name).toLowerCase());

export default class SocketServer {
    constructor(io, sessionManager, userManager) {
        this.io = io;
        this.sessionManager = sessionManager;
        this.userManager = userManager;
        this.filter = new Filter();

        this.handlers = {
            joinSession: this.joinSession.bind(this),
            joinSessions: this.joinSessions.bind(this),
            leaveSession: this.leaveSession.bind(this),
            projectChange: this.projectChange.bind(this),
            setTitle: this.setTitle.bind(this),
            setCursor: this.setCursor.bind(this),
            chat: this.chat.bind(this),
        };

        this.io.on('connection', client => this.handleConnection(client));
    }

    joinSession(data, client) {
        if (!this.requireProjectAccess(data.username, data.token, data.id, client)) return;
        if (!this.sessionManager.join(client, data.id, data.username)) {
            client.send({ noauth: true });
            return;
        }
        this.saveProfileId(data.username, data.pk);
    }

    joinSessions(data, client) {
        if (!Array.isArray(data.ids)) return;
        if (!authenticate(data.username, data.token)) {
            client.send({ noauth: true });
            return;
        }

        let joined = false;
        for (const projectId of data.ids.slice(0, 50)) {
            if (fullAuthenticate(data.username, data.token, projectId)
                && this.sessionManager.join(client, projectId, data.username)) {
                joined = true;
            }
        }
        if (joined) this.saveProfileId(data.username, data.pk);
    }

    leaveSession(data, client) {
        this.sessionManager.leave(client, data.id);
    }

    projectChange(data, client, callback) {
        if (!this.requireProjectAccess(data.username, data.token, data.lsId, client)) return;
        if (!this.requireJoinedIdentity(client, data.lsId, data.username)) return;

        this.sessionManager.projectChange(data.lsId, data, client);
        if (typeof callback === 'function') callback(this.sessionManager.getVersion(data.lsId));
    }

    setTitle(data, client) {
        if (!this.requireProjectAccess(data.username, data.token, data.lsId, client)) return;
        if (!this.requireJoinedIdentity(client, data.lsId, data.username)) return;
        if (typeof data.msg?.title !== 'string') return;

        const project = this.sessionManager.getProject(data.lsId);
        if (!project) return;

        data.msg.title = data.msg.title.slice(0, 200);
        project.project.title = data.msg.title;
        project.session.sendChangeFrom(client, data.msg, true);
    }

    setCursor(data, client) {
        if (!this.requireProjectAccess(data.username, data.token, data.lsId, client)) return;
        if (!this.requireJoinedIdentity(client, data.lsId, data.username)) return;

        const project = this.sessionManager.getProject(data.lsId);
        const cursor = project?.session.getClientFromSocket(client)?.cursor;
        if (!cursor || !data.cursor || typeof data.cursor !== 'object') return;

        for (const [key, value] of Object.entries(data.cursor)) {
            if (key in cursor) cursor[key] = value;
        }
    }

    async chat(data, client) {
        if (!data.msg?.msg || typeof data.msg.msg !== 'object') return;

        const sender = data.msg.msg.sender;
        if (!this.requireProjectAccess(sender, data.token, data.lsId, client)) return;
        if (!this.requireJoinedIdentity(client, data.lsId, sender)) return;

        const project = this.sessionManager.getProject(data.lsId);
        if (!project) return;

        delete data.msg.msg.linkify;
        let text = String(data.msg.msg.text ?? '').slice(0, 2000);
        data.msg.msg.text = text;

        if (admins.includes(sender?.toLowerCase()) && text.startsWith(BROADCAST_PREFIX)) {
            const broadcast = text.slice(BROADCAST_PREFIX.length);
            const logMessage = `Broadcast from ${sender}: "${broadcast}"`;
            console.log(logMessage);
            postText(logMessage);
            this.sessionManager.broadcastMessageToAllActiveProjects(broadcast);
        }

        const filterResult = await this.filter.checkContent(text);
        if (filterResult.isBad) {
            const originalText = text;
            text = filterResult.censoredContent || text;
            data.msg.msg.text = text;
            const logMessage = `${this.formatChatLog(project, sender, originalText, 'FILTERED')}\nCensored as: "${text}"`;
            console.warn(logMessage);
            postText(logMessage);
        }

        const bannedUsers = getBanned(false).map(name => name.toLowerCase());
        if (bannedUsers.includes(sender?.toLowerCase())) return;

        project.onChat(data.msg, client);
        const logMessage = this.formatChatLog(project, sender, text);
        console.log(logMessage);
        postText(logMessage);
    }

    formatChatLog(project, sender, text, prefix = 'CHAT') {
        const normalizedSender = sender?.toLowerCase();
        const recipients = project.session.getConnectedUsernames()
            .filter(username => username !== normalizedSender);
        return `${prefix}: "${text}" [${sender} -> ${recipients.join(', ')} | Scratch ${project.scratchId}]`;
    }

    saveProfileId(username, profileId) {
        if (!profileId) return;
        const user = this.userManager.getUser(username);
        if (user) user.pk = profileId;
    }

    socketJoinedAs(client, projectId, username) {
        const member = this.sessionManager.getProject(projectId)?.session.getClientFromSocket(client);
        return Boolean(member) && String(member.username).toLowerCase() === String(username).toLowerCase();
    }

    requireJoinedIdentity(client, projectId, username) {
        if (this.socketJoinedAs(client, projectId, username)) return true;
        client.send({ noauth: true });
        return false;
    }

    requireProjectAccess(username, token, projectId, client) {
        if (!authenticate(username, token)) {
            client.send({ noauth: true });
            return false;
        }
        if (!fullAuthenticate(username, token, projectId)) {
            client.send({ noaccess: true, id: projectId });
            return false;
        }
        return true;
    }

    recordActivity(data) {
        const projectId = data.lsId ?? data.id;
        if (!projectId) return;

        const project = this.sessionManager.getProject(projectId);
        const connected = project?.session.getConnectedUsernames();
        if (!connected) return;

        for (const username of connected) {
            addRecent(username, connected.length > 1, project.sharedWith.length > 0);
        }
    }

    handleConnection(client) {
        client.on('message', (data, callback) => {
            const handler = this.handlers[data?.type];
            if (!handler) {
                console.warn(`Discarded unknown socket message: ${data?.type}`);
                return;
            }

            try {
                this.recordActivity(data);
            } catch (error) {
                console.error('Could not record socket activity:', error);
            }

            try {
                const result = handler(data, client, callback);
                if (result?.catch) result.catch(error => console.error('Socket handler failed:', error));
            } catch (error) {
                console.error('Socket handler failed:', error);
            }
        });

        client.on('disconnect', () => this.sessionManager.disconnectSocket(client));
    }
}
