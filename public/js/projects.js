// Global map and marker storage
let projectMap = null;
let projectMarkers = [];

const projectIconMap = {
    feather: 'fa-solid fa-feather-pointed', paw: 'fa-solid fa-paw',
    frog: 'fa-solid fa-frog', water: 'fa-solid fa-droplet',
    bug: 'fa-solid fa-bug', fish: 'fa-solid fa-fish',
    leaf: 'fa-solid fa-leaf', cog: 'fa-solid fa-gear'
};

function hasProjectCoordinates(project) {
    return Number.isFinite(project.Latitude) && Math.abs(project.Latitude) <= 90 &&
        Number.isFinite(project.Longitude) && Math.abs(project.Longitude) <= 180;
}

// i18n helper - returns translation or fallback, never the key
function projectText(key, fallback) {
    if (window.i18n && typeof window.i18n.t === 'function') {
        const result = window.i18n.t(key);
        return result !== key ? result : fallback;
    }
    return fallback;
}

function escapeProjectText(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function projectLink(url, label, className) {
    if (!/^https?:\/\//i.test(url || '')) return '';
    return `<a href="${escapeProjectText(url)}" target="_blank" rel="noopener noreferrer" class="${className}">${label}</a>`;
}

function focusProject(index) {
    const marker = projectMarkers[index];
    if (!marker || !projectMap) return;
    document.getElementById('projects-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
        projectMap.invalidateSize();
        projectMap.setView(marker.getLatLng(), 10);
        marker.openPopup();
    }, 300);
}

function initProjectsMap(projects) {
    if (projectMap !== null) return;
    projectMap = L.map('projects-map', {
        scrollWheelZoom: false, zoomSnap: 0.5, minZoom: 2
    }).setView([20, 0], 2);

    // CARTO raster tiles require a key since September 2026. OSM standard tiles
    // support normal interactive browsing without a token; do not prefetch tiles.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(projectMap);

    projects.forEach((project, index) => {
        if (!hasProjectCoordinates(project)) {
            projectMarkers[index] = null;
            return;
        }
        const iconClass = projectIconMap[project['Species Icon']] || 'fa-solid fa-location-dot';
        const fallbackImage = '/img/dummy_project_image.png';
        const name = escapeProjectText(project['Project name']);
        const organization = escapeProjectText(project['Organization/Project lead'] || project.Country);
        const caption = escapeProjectText(project['Species Image Caption'] || project['Target species']);
        const imageUrl = escapeProjectText(project['Species Image'] || fallbackImage);
        const credit = escapeProjectText(project['Species Image Credit']);
        const location = escapeProjectText([project['Region/Location'], project.Country].filter(Boolean).join(', '));
        const popup = document.createElement('div');
        popup.className = 'map-popup';
        popup.innerHTML = `
            <div class="popup-header">
                <div class="popup-image-container"><img src="${imageUrl}" class="popup-image" alt="${caption}"></div>
                <div class="popup-header-info">
                    <div class="popup-title" title="${name}">${name}</div>
                    <div class="popup-org" title="${organization}">${organization}</div>
                </div>
            </div>
            <div class="popup-body">
                <div class="popup-meta-item"><i class="fa-solid fa-tag"></i><span>${escapeProjectText(project['Target species'])}</span></div>
                <div class="popup-meta-item"><i class="fa-solid fa-location-dot"></i><span>${location}</span></div>
                <div class="popup-links">
                    ${projectLink(project.Website, escapeProjectText(projectText('projectsMap.popup.website', 'Website')), 'btn btn-primary text-white')}
                    ${projectLink(project.Paper, escapeProjectText(projectText('projectsMap.popup.paper', 'Paper')), 'btn btn-outline-dark')}
                </div>
                ${credit ? `<div class="popup-image-credit text-muted mt-2" style="font-size: 0.7rem;">${escapeProjectText(projectText('projectsMap.popup.photo', 'Photo:'))} ${credit}</div>` : ''}
            </div>`;
        popup.querySelector('img').addEventListener('error', event => {
            const img = event.currentTarget;
            if (img.getAttribute('src') === fallbackImage) return;
            img.src = fallbackImage;
            img.alt = projectText('projectsMap.popup.placeholderAlt', 'Project image placeholder');
            const creditElement = popup.querySelector('.popup-image-credit');
            if (creditElement) creditElement.textContent = projectText('projectsMap.popup.placeholder', 'Placeholder:') + ' ChatGPT';
        });
        const customIcon = L.divIcon({
            className: 'custom-marker', html: `<i class="${iconClass}"></i>`,
            iconSize: [30, 30], iconAnchor: [15, 15]
        });
        projectMarkers[index] = L.marker([project.Latitude, project.Longitude], { icon: customIcon })
            .bindPopup(popup).addTo(projectMap);
    });
    setTimeout(() => projectMap.invalidateSize(), 100);
}

document.addEventListener('DOMContentLoaded', () => {
    const dataContainer = document.getElementById('project-data');
    const menu = document.getElementById('projectSelectorMenu');
    if (!dataContainer || !menu) return;
    const projects = JSON.parse(dataContainer.textContent).filter(hasProjectCoordinates)
        .sort((a, b) => a['Project name'].localeCompare(b['Project name']));
    const consentKey = 'birdnet_map_consent_2024';
    let consentGiven = false;
    // Storage can be disabled by browser privacy settings. Consent still works for this visit.
    try { consentGiven = localStorage.getItem(consentKey) === 'true'; } catch (error) { /* session only */ }

    function loadMap() {
        if (typeof L === 'undefined') {
            document.getElementById('project-map-error').hidden = false;
            return;
        }
        initProjectsMap(projects);
        document.getElementById('map-consent-overlay').classList.add('d-none');
    }

    window.acceptMapConsent = () => {
        consentGiven = true;
        try { localStorage.setItem(consentKey, 'true'); } catch (error) { /* session only */ }
        loadMap();
    };
    if (consentGiven) loadMap();

    menu.replaceChildren();
    projects.forEach((project, index) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dropdown-item d-flex align-items-center gap-3 py-2';
        const iconClass = projectIconMap[project['Species Icon']] || 'fa-solid fa-location-dot';
        button.innerHTML = `
            <div class="d-flex align-items-center justify-content-center bg-light rounded-circle" style="width: 28px; height: 28px; flex-shrink: 0;">
                <i class="${iconClass} text-primary" style="font-size: 0.85rem;"></i>
            </div>
            <div class="text-truncate">
                <span class="d-block text-truncate small fw-medium">${escapeProjectText(project['Project name'])}</span>
                <span class="d-block x-small text-muted">${escapeProjectText(project.Country || projectText('projectsMap.popup.global', 'Global'))}</span>
            </div>`;
        // Event listeners allow names containing apostrophes, quotes, and accented letters.
        button.addEventListener('click', () => {
            if (!consentGiven) {
                document.getElementById('map-consent-overlay').scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
            focusProject(index);
            document.querySelector('#projectSelectorBtn span').textContent = project['Project name'];
        });
        li.appendChild(button);
        menu.appendChild(li);
    });
});
