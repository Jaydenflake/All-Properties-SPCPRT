/**
 * @param {import('./units-data.mjs').Unit} unit
 */
export function showUnitCard(unit) {
  let root = document.getElementById('apartments-unit-card');
  if (!root) {
    root = document.createElement('div');
    root.id = 'apartments-unit-card';
    root.innerHTML = `
      <div class="apartments-unit-card-inner">
        <button type="button" class="apartments-unit-card-close" aria-label="Close">&times;</button>
        <div class="apartments-unit-badge">Available</div>
        <h2 class="apartments-unit-number"></h2>
        <p class="apartments-unit-price"></p>
        <dl class="apartments-unit-dl">
          <div><dt>Beds</dt><dd data-field="beds"></dd></div>
          <div><dt>Baths</dt><dd data-field="baths"></dd></div>
          <div><dt>Sq ft</dt><dd data-field="sqft"></dd></div>
        </dl>
        <a class="apartments-unit-apply" href="#" target="_blank" rel="noopener">Apply Now</a>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector('.apartments-unit-card-close').addEventListener('click', () => hideUnitCard());
  }

  root.classList.add('visible');
  root.querySelector('.apartments-unit-number').textContent = `Unit ${unit.unitNumber}`;
  root.querySelector('.apartments-unit-price').textContent = formatPrice(unit.price);
  root.querySelector('[data-field="beds"]').textContent = String(unit.beds);
  root.querySelector('[data-field="baths"]').textContent = String(unit.baths);
  root.querySelector('[data-field="sqft"]').textContent = String(unit.sqft);
  const apply = root.querySelector('.apartments-unit-apply');
  apply.href = unit.applyUrl || '#';
  apply.toggleAttribute('aria-disabled', !unit.applyUrl);
}

export function hideUnitCard() {
  const root = document.getElementById('apartments-unit-card');
  if (root) root.classList.remove('visible');
}

function formatPrice(n) {
  if (!Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}/mo`;
}
