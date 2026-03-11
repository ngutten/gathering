// emoji.js — Emoji shortcode map, converter, and picker

// Shortcode -> Unicode emoji map organized by category
export const emojiCategories = {
  'Smileys': {
    smile: '😄', laughing: '😆', blush: '😊', smiley: '😃', relaxed: '☺️',
    grinning: '😀', grin: '😁', joy: '😂', rofl: '🤣', sweat_smile: '😅',
    wink: '😉', kissing_heart: '😘', yum: '😋', stuck_out_tongue: '😛',
    stuck_out_tongue_winking_eye: '😜', stuck_out_tongue_closed_eyes: '😝',
    heart_eyes: '😍', star_struck: '🤩', thinking: '🤔', raised_eyebrow: '🤨',
    neutral_face: '😐', expressionless: '😑', unamused: '😒', rolling_eyes: '🙄',
    grimacing: '😬', lying_face: '🤥', relieved: '😌', pensive: '😔',
    sleepy: '😪', drooling_face: '🤤', sleeping: '😴', mask: '😷',
    face_with_thermometer: '🤒', nerd: '🤓', sunglasses: '😎', clown: '🤡',
    cowboy: '🤠', smirk: '😏', disappointed: '😞', worried: '😟',
    angry: '😠', rage: '😡', cry: '😢', sob: '😭',
    scream: '😱', confused: '😕', flushed: '😳', zany_face: '🤪',
    shushing: '🤫', hand_over_mouth: '🤭', monocle: '🧐', pleading: '🥺',
    skull: '💀', ghost: '👻', alien: '👽', robot: '🤖',
    poop: '💩', thumbsup: '👍', thumbsdown: '👎', wave: '👋',
    clap: '👏', pray: '🙏', handshake: '🤝', ok_hand: '👌',
    fire: '🔥', '100': '💯', sparkles: '✨', star: '⭐',
    heart: '❤️', broken_heart: '💔', orange_heart: '🧡', yellow_heart: '💛',
    green_heart: '💚', blue_heart: '💙', purple_heart: '💜',
    '+1': '👍', '-1': '👎', eyes: '👀', brain: '🧠',
  },
  'People': {
    baby: '👶', boy: '👦', girl: '👧', man: '👨', woman: '👩',
    older_man: '👴', older_woman: '👵', person_frowning: '🙍',
    person_raising_hand: '🙋', person_bowing: '🙇', facepalm: '🤦',
    shrug: '🤷', person_running: '🏃', dancer: '💃', man_dancing: '🕺',
    superhero: '🦸', supervillain: '🦹', ninja: '🥷',
    muscle: '💪', point_up: '☝️', v: '✌️', crossed_fingers: '🤞',
    metal: '🤘', call_me: '🤙', punch: '👊', fist: '✊',
    point_left: '👈', point_right: '👉', point_up_2: '👆', point_down: '👇',
    raised_hand: '✋', writing_hand: '✍️',
  },
  'Nature': {
    dog: '🐶', cat: '🐱', mouse: '🐭', hamster: '🐹', rabbit: '🐰',
    fox: '🦊', bear: '🐻', panda: '🐼', koala: '🐨', tiger: '🐯',
    lion: '🦁', cow: '🐮', pig: '🐷', frog: '🐸', monkey: '🐵',
    chicken: '🐔', penguin: '🐧', bird: '🐦', eagle: '🦅', owl: '🦉',
    bat: '🦇', wolf: '🐺', horse: '🐴', unicorn: '🦄', bee: '🐝',
    bug: '🐛', butterfly: '🦋', snail: '🐌', snake: '🐍', dragon: '🐉',
    turtle: '🐢', octopus: '🐙', whale: '🐋', dolphin: '🐬', fish: '🐟',
    shark: '🦈', crab: '🦀', lobster: '🦞',
    tree: '🌳', palm_tree: '🌴', cactus: '🌵', flower: '🌸', rose: '🌹',
    sunflower: '🌻', herb: '🌿', mushroom: '🍄', fallen_leaf: '🍂',
  },
  'Food': {
    apple: '🍎', pear: '🍐', orange: '🍊', lemon: '🍋', banana: '🍌',
    watermelon: '🍉', grapes: '🍇', strawberry: '🍓', peach: '🍑',
    cherry: '🍒', mango: '🥭', avocado: '🥑', tomato: '🍅', corn: '🌽',
    hot_pepper: '🌶️', pizza: '🍕', hamburger: '🍔', fries: '🍟',
    hotdog: '🌭', taco: '🌮', burrito: '🌯', egg: '🥚', cooking: '🍳',
    cake: '🎂', cookie: '🍪', chocolate: '🍫', candy: '🍬', lollipop: '🍭',
    donut: '🍩', icecream: '🍦', coffee: '☕', tea: '🍵', beer: '🍺',
    wine: '🍷', cocktail: '🍸', champagne: '🍾', sake: '🍶',
  },
  'Activities': {
    soccer: '⚽', basketball: '🏀', football: '🏈', baseball: '⚾',
    tennis: '🎾', volleyball: '🏐', rugby: '🏉', bowling: '🎳',
    golf: '⛳', fishing: '🎣', skiing: '⛷️', snowboarder: '🏂',
    swimming: '🏊', surfing: '🏄', biking: '🚴', climbing: '🧗',
    trophy: '🏆', medal: '🏅', first_place: '🥇', second_place: '🥈',
    third_place: '🥉', video_game: '🎮', joystick: '🕹️', dart: '🎯',
    chess: '♟️', dice: '🎲', puzzle: '🧩', art: '🎨', guitar: '🎸',
    microphone: '🎤', headphones: '🎧', musical_note: '🎵', notes: '🎶',
    movie: '🎬', camera: '📷', computer: '💻', keyboard: '⌨️',
  },
  'Travel': {
    car: '🚗', taxi: '🚕', bus: '🚌', ambulance: '🚑', fire_engine: '🚒',
    police_car: '🚓', truck: '🚚', racing_car: '🏎️', motorcycle: '🏍️',
    bicycle: '🚲', rocket: '🚀', airplane: '✈️', helicopter: '🚁',
    ship: '🚢', sailboat: '⛵', anchor: '⚓', train: '🚆',
    mountain: '⛰️', camping: '🏕️', beach: '🏖️', desert: '🏜️',
    house: '🏠', office: '🏢', hospital: '🏥', school: '🏫',
    church: '⛪', castle: '🏰', statue_of_liberty: '🗽',
    earth_americas: '🌎', earth_asia: '🌏', earth_africa: '🌍',
    sun: '☀️', moon: '🌙', cloud: '☁️', rainbow: '🌈',
    umbrella: '☂️', snowflake: '❄️', lightning: '⚡', tornado: '🌪️',
  },
  'Objects': {
    watch: '⌚', phone: '📱', laptop: '💻', desktop: '🖥️',
    printer: '🖨️', mouse_computer: '🖱️', cd: '💿', floppy: '💾',
    bulb: '💡', flashlight: '🔦', candle: '🕯️', book: '📖',
    books: '📚', notebook: '📓', pencil: '✏️', pen: '🖊️',
    envelope: '✉️', email: '📧', mailbox: '📬', package: '📦',
    lock: '🔒', unlock: '🔓', key: '🔑', hammer: '🔨',
    wrench: '🔧', gear: '⚙️', bomb: '💣', knife: '🔪',
    shield: '🛡️', pill: '💊', syringe: '💉', dna: '🧬',
    telescope: '🔭', microscope: '🔬', satellite: '📡', battery: '🔋',
    plug: '🔌', magnet: '🧲', money: '💰', gem: '💎', bell: '🔔',
    trophy2: '🏆', medal2: '🎖️', flag: '🏁',
  },
  'Symbols': {
    check: '✅', x: '❌', warning: '⚠️', no_entry: '⛔',
    question: '❓', exclamation: '❗', interrobang: '⁉️',
    recycle: '♻️', infinity: '♾️', peace: '☮️',
    heavy_check: '✔️', heavy_multiply: '✖️', plus: '➕', minus: '➖',
    arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️',
    new: '🆕', free: '🆓', up: '🆙', cool: '🆒', sos: '🆘',
    info: 'ℹ️', abc: '🔤', hash: '#️⃣',
    zero: '0️⃣', one: '1️⃣', two: '2️⃣', three: '3️⃣', four: '4️⃣',
    five: '5️⃣', six: '6️⃣', seven: '7️⃣', eight: '8️⃣', nine: '9️⃣', ten: '🔟',
    copyright: '©️', registered: '®️', tm: '™️',
  },
};

// Flat shortcode -> emoji map
const emojiMap = {};
for (const cat of Object.values(emojiCategories)) {
  Object.assign(emojiMap, cat);
}

/**
 * Replace :shortcode: patterns with unicode emoji
 */
export function convertShortcodes(text) {
  return text.replace(/:([a-zA-Z0-9_+-]+):/g, (match, code) => {
    return emojiMap[code] || match;
  });
}

// ── Emoji Picker ────────────────────────────────────────────────────

let pickerEl = null;
let currentInputId = null;

export function toggleEmojiPicker(inputId) {
  if (pickerEl && pickerEl.style.display !== 'none') {
    pickerEl.style.display = 'none';
    return;
  }
  currentInputId = inputId;
  if (!pickerEl) {
    pickerEl = createPicker();
    document.body.appendChild(pickerEl);
  }
  // Position near the input
  const btn = document.getElementById('emoji-btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    pickerEl.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    pickerEl.style.left = rect.left + 'px';
  }
  pickerEl.style.display = 'flex';
  const searchInput = pickerEl.querySelector('.emoji-search');
  if (searchInput) searchInput.focus();
}

function createPicker() {
  const el = document.createElement('div');
  el.className = 'emoji-picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Emoji picker');
  el.onclick = (e) => e.stopPropagation();

  // Search bar
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'emoji-search';
  search.placeholder = 'Search emoji...';
  search.oninput = () => filterEmoji(search.value, el);
  el.appendChild(search);

  // Category tabs
  const tabs = document.createElement('div');
  tabs.className = 'emoji-tabs';
  const catNames = Object.keys(emojiCategories);
  const tabIcons = ['😄', '👋', '🐶', '🍕', '⚽', '🚗', '💡', '✅'];
  catNames.forEach((cat, i) => {
    const tab = document.createElement('button');
    tab.textContent = tabIcons[i] || cat[0];
    tab.title = cat;
    tab.onclick = () => {
      el.querySelectorAll('.emoji-tabs button').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      showCategory(cat, el);
      search.value = '';
    };
    if (i === 0) tab.classList.add('active');
    tabs.appendChild(tab);
  });
  el.appendChild(tabs);

  // Grid container
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  el.appendChild(grid);

  showCategory(catNames[0], el);

  // Close picker on outside click or Escape
  document.addEventListener('click', (e) => {
    if (pickerEl && pickerEl.style.display !== 'none' && !pickerEl.contains(e.target) && e.target.id !== 'emoji-btn') {
      pickerEl.style.display = 'none';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pickerEl && pickerEl.style.display !== 'none') {
      pickerEl.style.display = 'none';
      const btn = document.getElementById('emoji-btn');
      if (btn) btn.focus();
    }
  });

  return el;
}

function showCategory(cat, pickerRoot) {
  const grid = pickerRoot.querySelector('.emoji-grid');
  grid.innerHTML = '';
  const emojis = emojiCategories[cat];
  for (const [code, emoji] of Object.entries(emojis)) {
    const btn = document.createElement('button');
    btn.className = 'emoji-item';
    btn.textContent = emoji;
    btn.title = `:${code}:`;
    btn.onclick = () => insertEmoji(emoji);
    grid.appendChild(btn);
  }
}

function filterEmoji(query, pickerRoot) {
  const grid = pickerRoot.querySelector('.emoji-grid');
  grid.innerHTML = '';
  if (!query) {
    // Show active category
    const activeTab = pickerRoot.querySelector('.emoji-tabs button.active');
    if (activeTab) showCategory(activeTab.title, pickerRoot);
    return;
  }
  const q = query.toLowerCase();
  for (const [code, emoji] of Object.entries(emojiMap)) {
    if (code.toLowerCase().includes(q)) {
      const btn = document.createElement('button');
      btn.className = 'emoji-item';
      btn.textContent = emoji;
      btn.title = `:${code}:`;
      btn.onclick = () => insertEmoji(emoji);
      grid.appendChild(btn);
    }
  }
}

function insertEmoji(emoji) {
  const input = document.getElementById(currentInputId);
  if (!input) return;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
  input.selectionStart = input.selectionEnd = start + emoji.length;
  input.focus();
  pickerEl.style.display = 'none';
}

// ── Reaction Emoji Picker ────────────────────────────────────────────

let reactionPickerEl = null;
let reactionCallback = null;

export function openReactionPicker(anchorEl, callback) {
  if (reactionPickerEl && reactionPickerEl.style.display !== 'none') {
    reactionPickerEl.style.display = 'none';
    return;
  }
  reactionCallback = callback;
  if (!reactionPickerEl) {
    reactionPickerEl = createReactionPicker();
    document.body.appendChild(reactionPickerEl);
  }
  const rect = anchorEl.getBoundingClientRect();
  reactionPickerEl.style.top = (rect.bottom + 4) + 'px';
  reactionPickerEl.style.left = Math.max(4, rect.left - 100) + 'px';
  reactionPickerEl.style.display = 'flex';
  const searchInput = reactionPickerEl.querySelector('.emoji-search');
  if (searchInput) { searchInput.value = ''; searchInput.focus(); }
  showReactionCategory(Object.keys(emojiCategories)[0], reactionPickerEl);
}

export function closeReactionPicker() {
  if (reactionPickerEl) reactionPickerEl.style.display = 'none';
}

function createReactionPicker() {
  const el = document.createElement('div');
  el.className = 'emoji-picker reaction-picker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Reaction picker');
  el.onclick = (e) => e.stopPropagation();

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'emoji-search';
  search.placeholder = 'Search emoji...';
  search.oninput = () => filterReactionEmoji(search.value, el);
  el.appendChild(search);

  const tabs = document.createElement('div');
  tabs.className = 'emoji-tabs';
  const catNames = Object.keys(emojiCategories);
  const tabIcons = ['😄', '👋', '🐶', '🍕', '⚽', '🚗', '💡', '✅'];
  catNames.forEach((cat, i) => {
    const tab = document.createElement('button');
    tab.textContent = tabIcons[i] || cat[0];
    tab.title = cat;
    tab.onclick = () => {
      el.querySelectorAll('.emoji-tabs button').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      showReactionCategory(cat, el);
      search.value = '';
    };
    if (i === 0) tab.classList.add('active');
    tabs.appendChild(tab);
  });
  el.appendChild(tabs);

  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  el.appendChild(grid);

  showReactionCategory(catNames[0], el);

  document.addEventListener('click', (e) => {
    if (reactionPickerEl && reactionPickerEl.style.display !== 'none' &&
        !reactionPickerEl.contains(e.target) && !e.target.classList.contains('react-btn')) {
      reactionPickerEl.style.display = 'none';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && reactionPickerEl && reactionPickerEl.style.display !== 'none') {
      reactionPickerEl.style.display = 'none';
    }
  });

  return el;
}

function showReactionCategory(cat, pickerRoot) {
  const grid = pickerRoot.querySelector('.emoji-grid');
  grid.innerHTML = '';
  const emojis = emojiCategories[cat];
  for (const [code, emoji] of Object.entries(emojis)) {
    const btn = document.createElement('button');
    btn.className = 'emoji-item';
    btn.textContent = emoji;
    btn.title = `:${code}:`;
    btn.onclick = () => {
      if (reactionCallback) reactionCallback(emoji);
      reactionPickerEl.style.display = 'none';
    };
    grid.appendChild(btn);
  }
}

function filterReactionEmoji(query, pickerRoot) {
  const grid = pickerRoot.querySelector('.emoji-grid');
  grid.innerHTML = '';
  if (!query) {
    const activeTab = pickerRoot.querySelector('.emoji-tabs button.active');
    if (activeTab) showReactionCategory(activeTab.title, pickerRoot);
    return;
  }
  const q = query.toLowerCase();
  for (const [code, emoji] of Object.entries(emojiMap)) {
    if (code.toLowerCase().includes(q)) {
      const btn = document.createElement('button');
      btn.className = 'emoji-item';
      btn.textContent = emoji;
      btn.title = `:${code}:`;
      btn.onclick = () => {
        if (reactionCallback) reactionCallback(emoji);
        reactionPickerEl.style.display = 'none';
      };
      grid.appendChild(btn);
    }
  }
}
