const $ = (selector) => document.querySelector(selector);
const proposal = $('#proposal-modal');
const provision = $('#provision-modal');
const recursive = $('#recursive-modal');
let mayaCreated = false;
let visualCreated = false;

function openModal(element) { element.classList.remove('hidden'); }
function closeModal(element) { element.classList.add('hidden'); }
function activity(text, detail, kind = 'good') {
  const now = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  $('#activity-feed').insertAdjacentHTML('afterbegin', `<div class="feed-item"><time>${now}</time><span class="event-icon ${kind}">${kind === 'good' ? '✓' : '✦'}</span><p>${text}<small>${detail}</small></p></div>`);
}
function addMaya() {
  if (mayaCreated) return;
  mayaCreated = true;
  $('#dynamic-reports').insertAdjacentHTML('afterbegin', `<article class="agent-card" id="maya-card"><div class="agent-avatar maya">MY</div><div><b>Maya Chen</b><span>Social Media Manager</span></div><span class="status working-status">WORKING</span></article>`);
  $('#agent-count').textContent = '5';
  activity('<b>Maya Chen</b> joined Growth as Social Media Manager.', 'Agent activated and manager connected');
  setTimeout(() => openModal(recursive), 800);
}
function addVisualAgent() {
  if (visualCreated) return;
  visualCreated = true;
  closeModal(recursive);
  $('#dynamic-reports').insertAdjacentHTML('afterbegin', `<article class="agent-card"><div class="agent-avatar" style="background:#eee0f4;color:#765487">VC</div><div><b>Vera Cole</b><span>Visual Content Agent</span></div><span class="status active-status">ACTIVE</span></article>`);
  $('#agent-count').textContent = '6';
  activity('<b>Vera Cole</b> was hired from Maya’s capability request.', 'Recursive recruitment approved');
}

$('#generate-button').addEventListener('click', () => openModal(proposal));
$('#hire-input').addEventListener('keydown', event => { if (event.key === 'Enter') openModal(proposal); });
$('#add-report').addEventListener('click', () => openModal(proposal));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.closest('.modal-backdrop'))));
document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(backdrop); }));

$('#approve-hire').addEventListener('click', async () => {
  closeModal(proposal); openModal(provision);
  const steps = ['Identity created', 'Organizational context connected', 'Working memory initialized', 'Role evaluation passed', 'Deployment verified'];
  for (const step of steps) {
    $('#provision-steps').insertAdjacentHTML('beforeend', `<div class="provision-step"><span class="step-state">○</span>${step}</div>`);
    await new Promise(resolve => setTimeout(resolve, 480));
    const current = $('#provision-steps').lastElementChild;
    current.classList.add('done'); current.querySelector('.step-state').textContent = '✓';
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  closeModal(provision); $('#provision-steps').innerHTML = ''; addMaya();
});
$('#approve-recursive').addEventListener('click', addVisualAgent);
