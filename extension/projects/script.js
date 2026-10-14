var version = chrome.runtime.getManifest().version;
document.querySelector('#version').innerHTML = 'v'+version;

async function getProjects() {
    let info = await chrome.runtime.sendMessage({meta:'getUsernamePlus'});
    let apiUrl = info.apiUrl;
    let lsToken = info.currentLsToken;
    let uname = info.uname;
 
    var data = await (
        await fetch(
            `${apiUrl}/userProjectsScratch/${uname}/`,
            {headers:{authorization:lsToken}},
        )
    ).json();
    if (!Array.isArray(data)) {
        var error = document.createElement('div');
        error.className = 'empty-state';
        error.textContent = data?.noauth ? 'Sign in to LiveScratch to view your projects.' : 'Projects could not be loaded. Try again shortly.';
        document.querySelector('.projects').appendChild(error);
        return;
    }
    if (data.length === 0) {
        var span = document.createElement('span');
        span.className = 'empty-state';
        span.textContent = 'No projects yet. Open one of your Scratch projects and enable LiveScratch to get started.';
        document.querySelector('.projects').appendChild(span);
    }
    data.forEach(function (project) {
        var div = document.createElement('div');
        div.className = 'project';

        var img = document.createElement('img');
        img.src = `https://cdn2.scratch.mit.edu/get_image/project/${project.scratchId}_480x360.png`;

        var title = document.createElement('span');
        title.className = 'title';
        title.textContent = project.title;

        var details = document.createElement('span');
        details.className = 'project-details';
        const onlineCount = Array.isArray(project.online) ? project.online.length : 0;
        details.textContent = onlineCount ? `${onlineCount} online now` : `Last edited by ${project.lastUser || 'unknown'}`;

        var action = document.createElement('span');
        action.className = 'project-action';
        action.textContent = 'Open editor';

        div.appendChild(img);
        div.appendChild(title);
        div.appendChild(details);
        div.appendChild(action);
        document.querySelector('.projects').appendChild(div);

        div.addEventListener('click', function () {
            chrome.tabs.create({
                url: `https://scratch.mit.edu/projects/${project.scratchId}/editor`,
            });
        });
    });
}
getProjects();
