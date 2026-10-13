/** Toggle showroom projects by the tags displayed on their cards. */
(() => {
  'use strict';

  const controls = document.getElementById('showroom-filters');
  const grid = document.getElementById('showroom-grid');
  if (!controls || !grid) return;

  const tagControls = document.getElementById('showroom-filter-tags');
  const reset = document.getElementById('showroom-filter-reset');
  const count = document.getElementById('showroom-filter-count');
  const invite = grid.querySelector('[data-showroom-invite]');
  const selected = new Set();
  const buttons = new Map();
  const tags = new Map();

  // Use the existing badges as the source of tag names and colors.
  const projects = [...grid.querySelectorAll('.showroom-card')].map(card => {
    const projectTags = [...card.querySelectorAll('.badge')].map(badge => {
      const tag = badge.textContent.trim();
      if (!tags.has(tag)) tags.set(tag, badge.className);
      return tag;
    });
    return { column: card.closest('.col'), tags: projectTags };
  });

  function update() {
    let visible = 0;
    for (const project of projects) {
      const matches = selected.size === 0 || project.tags.some(tag => selected.has(tag));
      project.column.hidden = !matches;
      if (matches) visible++;
    }

    for (const [tag, button] of buttons) {
      button.setAttribute('aria-pressed', String(selected.has(tag)));
    }

    if (invite) invite.hidden = selected.size > 0;
    reset.disabled = selected.size === 0;
    count.textContent = `${visible} / ${projects.length}`;
  }

  for (const [tag, classes] of tags) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${classes.replace(/\bbadge\b/g, '').trim()} showroom-filter-button`;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-controls', 'showroom-grid');

    const indicator = document.createElement('span');
    indicator.className = 'showroom-filter-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const check = document.createElement('i');
    check.className = 'bi bi-check-lg';
    indicator.append(check);
    button.append(indicator, document.createTextNode(tag));

    button.addEventListener('click', () => {
      if (selected.has(tag)) selected.delete(tag);
      else selected.add(tag);
      update();
    });

    buttons.set(tag, button);
    tagControls.append(button);
  }

  reset.addEventListener('click', () => {
    selected.clear();
    update();
  });

  update();
  controls.hidden = false;
})();
