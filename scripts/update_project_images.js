// Run manually with node scripts/update_project_images.js; normal builds stay offline.
const fs = require('node:fs');
const path = require('node:path');
const filename = path.join(__dirname, '../src/_data/projects.js');
const projects = require(filename);
const api = 'https://birdnet.cornell.edu/taxonomy/api';

async function main() {
    const species = [...new Set(projects.map(p => p['Species Image Scientific Name']).filter(Boolean))];
    const records = new Map();
    // Fetch metadata once per species, keeping requests sequential to respect the service.
    for (const name of species) {
        const response = await fetch(`${api}/species/${encodeURIComponent(name)}?fields=scientific_name,common_name,image`, {
            signal: AbortSignal.timeout(30000)
        });
        if (!response.ok) throw new Error(`${name}: taxonomy returned HTTP ${response.status}`);
        const record = await response.json();
        if (!record.image?.medium || !record.image?.author || !record.image?.license) {
            throw new Error(`${name}: missing image or attribution; project data was not written`);
        }
        records.set(name, record);
    }
    let updated = 0;
    for (const project of projects) {
        const record = records.get(project['Species Image Scientific Name']);
        if (!record) continue;
        project['Species Image Scientific Name'] = record.scientific_name;
        project['Species Image'] = record.image.medium;
        project['Species Image Credit'] = [record.image.author, record.image.license, record.image.source].filter(Boolean).join(' · ');
        project['Species Image Caption'] = record.common_name;
        updated++;
    }
    const header = fs.readFileSync(filename, 'utf8').split('module.exports =')[0];
    fs.writeFileSync(filename, `${header}module.exports = ${JSON.stringify(projects, null, 2)};\n`);
    console.log(`Updated ${updated} project images from ${records.size} taxonomy species.`);
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
