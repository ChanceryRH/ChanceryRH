/* Finite product stories: animate once in view, hold the result, replay on demand. */
(() => {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const scenes = [...document.querySelectorAll('.kinetic-scene')];
  const states = new Map();
  const workspace = document.querySelector('#product-visual');
  const fitWorkspace = new ResizeObserver(() => {
    workspace.style.setProperty('--workspace-scale', (workspace.clientWidth / 750).toFixed(5));
  });
  fitWorkspace.observe(workspace);
  const resize = new ResizeObserver(entries => {
    for (const {target} of entries) {
      const scale = Math.min(target.clientWidth / 496, (target.clientHeight - 72) / 324);
      target.style.setProperty('--scene-scale', scale.toFixed(4));
    }
  });
  const captions = {
    clerk: ['Give the routine a little help.', 'Checking the office rulebook.', 'Turning context into a draft.', 'Clerks prepare. People decide.'],
    ledger: ['Every line has a source.', 'Checking the sample receipt trail.', 'Three line items. One clear statement.']
  };
  function phase(scene, value) {
    scene.dataset.phase = value;
    const type = scene.dataset.scene;
    if (captions[type]) scene.querySelector('.scene-caption').textContent = captions[type][value];
  }
  function finish(scene) {
    const state = states.get(scene);
    state.running = false;
    state.steps = [];
    const button = scene.querySelector('.scene-action');
    if (button) {
      button.disabled = false;
      button.innerHTML = scene.dataset.scene === 'clerk' ? 'Replay the workflow <span>↻</span>' : 'Verify again <span>↻</span>';
    }
  }
  function tick(scene, now) {
    const state = states.get(scene);
    if (!state.running) return;
    state.elapsed += now - state.last;
    state.last = now;
    while (state.steps.length && state.elapsed >= state.steps[0][0]) {
      phase(scene, state.steps.shift()[1]);
    }
    if (!state.steps.length) finish(scene);
  }
  let frame = 0;
  function animate(now) {
    frame = 0;
    for (const [scene, state] of states) {
      if (state.running && state.visible && !document.hidden) tick(scene, now);
      else state.last = now;
    }
    schedule();
  }
  function schedule() {
    if (!frame && !document.hidden && [...states.values()].some(state => state.running && state.visible)) frame = requestAnimationFrame(animate);
  }
  function play(scene) {
    const state = states.get(scene), type = scene.dataset.scene;
    phase(scene, 0);
    if (motion.matches) {
      phase(scene, type === 'clerk' ? 3 : 2);
      finish(scene);
      return;
    }
    state.running = true;
    state.elapsed = 0;
    state.last = performance.now();
    state.steps = type === 'clerk' ? [[500, 1], [1600, 2], [3300, 3]] : [[300, 1], [2300, 2]];
    const button = scene.querySelector('.scene-action');
    button.disabled = true;
    button.innerHTML = type === 'clerk' ? 'Preparing draft <span>·</span>' : 'Checking receipt <span>·</span>';
    schedule();
  }
  const observer = new IntersectionObserver(entries => {
    for (const {target:scene, isIntersecting} of entries) {
      const state = states.get(scene);
      state.visible = isIntersecting;
      state.last = performance.now();
      if (isIntersecting && !state.seen) {
        state.seen = true;
        if (scene.dataset.scene === 'clerk' || scene.dataset.scene === 'ledger') play(scene);
      }
    }
    schedule();
  }, {threshold:.42});
  for (const scene of scenes) {
    states.set(scene, {visible:false, seen:false, running:false, elapsed:0, last:performance.now(), steps:[]});
    resize.observe(scene);
    observer.observe(scene);
  }
  document.querySelectorAll('[data-scene-action]').forEach(button => {
    button.addEventListener('click', () => {
      const scene = button.closest('.kinetic-scene');
      if (scene.dataset.scene !== 'room') return play(scene);
      const opened = scene.dataset.phase === '2';
      phase(scene, opened ? 0 : 2);
      button.innerHTML = opened ? 'Open the room <span>↗</span>' : 'Seal the room <span>↙</span>';
      button.setAttribute('aria-label', opened ? 'Open the sample encrypted room' : 'Seal the sample encrypted room');
      button.setAttribute('aria-expanded', String(!opened));
      scene.querySelector('.scene-caption').textContent = opened ? 'Shared context. Private by design.' : 'The right people. The whole picture.';
    });
  });
  const range = document.querySelector('#clerk-cap');
  function updateCap() {
    const cap = Number(range.value), used = 42.18, nextTask = 120;
    document.querySelector('#cap-amount').value = cap;
    range.setAttribute('aria-valuetext', `${cap} USDG per month`);
    range.style.background = `linear-gradient(to right, #7684a8 ${(cap-50)/250*100}%, #9ba6bf44 ${(cap-50)/250*100}%)`;
    document.querySelector('.mandate-scale i').style.width = `${used/cap*100}%`;
    const allowed = nextTask <= cap-used;
    document.querySelector('.cap-check').dataset.allowed = String(allowed);
    document.querySelector('.cap-check>i').textContent = allowed ? '✓' : '↗';
    document.querySelector('#cap-outcome').textContent = allowed ? `Within the allowance. ${(cap-used-nextTask).toFixed(2)} USDG left after this task.` : 'Above the remaining allowance. Ask first.';
  }
  range.addEventListener('input', updateCap);
  updateCap();
  const marquee = document.querySelector('.model-section .audience-types');
  const pause = document.querySelector('.marquee-control');
  pause.addEventListener('click', () => {
    const paused = marquee.dataset.paused !== 'true';
    marquee.dataset.paused = String(paused);
    pause.setAttribute('aria-pressed', String(paused));
    pause.setAttribute('aria-label', paused ? 'Play model logos' : 'Pause model logos');
    pause.innerHTML = paused ? '<span aria-hidden="true">▶</span> Play' : '<span aria-hidden="true">Ⅱ</span> Pause';
  });
  document.addEventListener('visibilitychange', () => {
    for (const state of states.values()) state.last = performance.now();
    schedule();
  });
  motion.addEventListener('change', () => {
    if (motion.matches) for (const [scene,state] of states) {
      if (state.running) { phase(scene, scene.dataset.scene === 'clerk' ? 3 : 2); finish(scene); }
    }
  });
})();
