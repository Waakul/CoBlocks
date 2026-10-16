const projectsContainer = document.querySelector('.projects');
const version = chrome.runtime.getManifest().version;
document.querySelector('#version').textContent = `v${version}`;

function showMessage(message) {
    const element = document.createElement('div');
    element.className = 'empty-state';
    element.textContent = message;
    projectsContainer.replaceChildren(element);
}

function openProject(scratchId) {
    chrome.tabs.create({ url: `https://scratch.mit.edu/projects/${scratchId}/editor` });
}

function createProjectCard(project) {
    const card = document.createElement('article');
    card.className = 'project';
    card.tabIndex = 0;
    card.setAttribute('role', 'link');

    const image = document.createElement('img');
    image.src = `https://cdn2.scratch.mit.edu/get_image/project/${project.scratchId}_480x360.png`;
    image.alt = '';
    image.loading = 'lazy';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = project.title || 'Untitled project';

    const details = document.createElement('span');
    details.className = 'project-details';
    const onlineCount = Array.isArray(project.online) ? project.online.length : 0;
    details.textContent = onlineCount
        ? `${onlineCount} online now`
        : `Last edited by ${project.lastUser || 'unknown'}`;

    const action = document.createElement('span');
    action.className = 'project-action';
    action.textContent = 'Open editor';

    card.append(image, title, details, action);
    card.addEventListener('click', () => openProject(project.scratchId));
    card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openProject(project.scratchId);
        }
    });
    return card;
}

async function loadProjects() {
    try {
        const account = await chrome.runtime.sendMessage({ meta: 'getUsernamePlus' });
        const response = await fetch(`${account.apiUrl}/userProjectsScratch/${account.uname}/`, {
            headers: { authorization: account.currentLsToken },
        });
        const projects = await response.json();

        if (!Array.isArray(projects)) {
            showMessage(projects?.noauth
                ? 'Sign in to CoBlocks to view your projects.'
                : 'Projects could not be loaded. Try again shortly.');
            return;
        }
        if (projects.length === 0) {
            showMessage('No projects yet. Open one of your Scratch projects and enable CoBlocks to get started.');
            return;
        }

        projectsContainer.replaceChildren(...projects.map(createProjectCard));
    } catch (error) {
        console.error('Could not load CoBlocks projects:', error);
        showMessage('Projects could not be loaded. Try again shortly.');
    }
}

loadProjects();
