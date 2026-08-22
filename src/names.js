// names.js — generowanie realistycznych nicków i emaili dla botów.
// Zasady nicku z API.md: 3-24 znaki, tylko [a-zA-Z0-9_], unikalny globalnie
// (bez rozróżniania wielkości liter). Polskie znaki wymagają transliteracji.
//
// Wzorce:
//   gamer  -> SilentWolf42, DarkFalcon, CrazyFox1999, TurboShark7
//   polish -> Marek1995, marek_nowak, ZlotyOrzel, Kasia02
//   mixed  -> losowy wybór między stylami

export const DEFAULT_EMAIL_DOMAINS = [
  'gmail.com',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'onet.pl',
  'proton.me',
  'outlook.com',
];

const PL_NAMES = [
  'Marek', 'Kamil', 'Piotr', 'Michal', 'Tomek', 'Bartek', 'Krzysiek', 'Lukasz',
  'Dawid', 'Patryk', 'Szymon', 'Adam', 'Jan', 'Wojtek', 'Marcin', 'Karol',
  'Kuba', 'Grzegorz', 'Rafal', 'Pawel', 'Sebastian', 'Norbert',
  'Ola', 'Kasia', 'Ania', 'Magda', 'Ewa', 'Natalia', 'Zuza', 'Karolina',
  'Monika', 'Paulina', 'Weronika', 'Julia', 'Maja', 'Agnieszka', 'Dorota', 'Iza', 'Gosia',
];

const EN_ADJ = [
  'Fast', 'Silent', 'Crazy', 'Lucky', 'Golden', 'Dark', 'Neon', 'Cyber',
  'Turbo', 'Iron', 'Storm', 'Night', 'Shadow', 'Pixel', 'Quantum', 'Atomic',
  'Cosmic', 'Hyper', 'Mega', 'Ultra', 'Wild', 'Savage', 'Elite', 'Blaze',
  'Frost', 'Thunder', 'Lone', 'Cold', 'Brave', 'Quick', 'Steel', 'Solar',
];

const ANIMALS = [
  'Wolf', 'Fox', 'Tiger', 'Eagle', 'Shark', 'Falcon', 'Lion', 'Bear', 'Hawk',
  'Panda', 'Dragon', 'Phoenix', 'Raven', 'Cobra', 'Panther', 'Owl', 'Lynx',
  'Viper', 'Condor', 'Rhino', 'Badger', 'Heron', 'Jackal', 'Husky',
];

const PL_NOUNS = [
  'Orzel', 'Wilk', 'Lis', 'Tygrys', 'Sokol', 'Jastrzab', 'Rys', 'Dzik',
  'Sowa', 'Borsuk', 'Karp', 'Zmija', 'Niedzwiedz', 'Kruk', 'Zubr',
];

const SURNAMES = [
  'Nowak', 'Kowalski', 'Wisniewski', 'Wojcik', 'Kowalczyk', 'Kaminski',
  'Lewandowski', 'Zielinski', 'Szymanski', 'Wozniak', 'Dabrowski', 'Kozlowski',
  'Jankowski', 'Mazur', 'Krawczyk', 'Piotrowski', 'Grabowski', 'Zawadzki',
  'Sikora', 'Pawlak', 'Michalski', 'Gorski', 'Witkowski', 'Baran', 'Duda', 'Adamczyk',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Transliteracja polskich znaków (API dopuszcza tylko [a-zA-Z0-9_]).
export function transliterate(s) {
  return s
    .replace(/ą/g, 'a').replace(/Ą/g, 'A')
    .replace(/ć/g, 'c').replace(/Ć/g, 'C')
    .replace(/ę/g, 'e').replace(/Ę/g, 'E')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .replace(/ń/g, 'n').replace(/Ń/g, 'N')
    .replace(/ó/g, 'o').replace(/Ó/g, 'O')
    .replace(/ś/g, 's').replace(/Ś/g, 'S')
    .replace(/ż/g, 'z').replace(/Ż/g, 'Z')
    .replace(/ź/g, 'z').replace(/Ź/g, 'Z');
}

function gamerNick() {
  const adj = pick(EN_ADJ);
  const noun = pick(ANIMALS);
  const r = Math.random();
  if (r < 0.55) return adj + noun + rnd(0, 999); // SilentWolf42
  if (r < 0.85) return adj + noun; // DarkFalcon
  return adj + rnd(10, 99) + noun; // Cyber77Fox
}

function polishNick() {
  const name = pick(PL_NAMES);
  const r = Math.random();
  if (r < 0.45) return name + rnd(1, 999); // Marek1995
  if (r < 0.75) return name.toLowerCase() + '_' + pick(SURNAMES).toLowerCase(); // marek_nowak
  if (r < 0.92) return transliterate(pick(PL_NOUNS)) + rnd(1, 999); // ZlotyOrzel → Orzel77
  return name; // Julia
}

// Pamięć procesu: gwarantuje, że w obrębie jednego uruchomienia żaden nick
// ani email się nie powtórzy (osobno od exclude z accounts.json i retry 422).
const usedNames = new Set();
const usedEmails = new Set();

// Wygeneruj nick nieobecny w exclude (Set małych liter). Randomowe wzorce bez
// sufiksu mają ograniczoną liczbę kombinacji — stąd usedNames + 400 prób.
export function generateNickname(style = 'mixed', exclude = new Set()) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const nick = style === 'gamer' ? gamerNick() : style === 'polish' ? polishNick() : Math.random() < 0.5 ? gamerNick() : polishNick();
    const key = nick.toLowerCase();
    if (nick.length >= 3 && nick.length <= 24 && !exclude.has(key) && !usedNames.has(key)) {
      usedNames.add(key);
      return nick;
    }
  }
  const fallback = `trader${rnd(10, 99999)}`;
  usedNames.add(fallback.toLowerCase());
  return fallback;
}

// Email złożony z nicku lub wzorca imie.nazwisko. Unikalność: nicki są unikalne
// globalnie, więc nick@domena też; wzorzec imie.nazwisko może się powtórzyć —
// obsługuje to retry na 422 w managerze.
export function generateEmail({ nickname, style = 'mixed', domains = DEFAULT_EMAIL_DOMAINS }) {
  const list = Array.isArray(domains) && domains.length ? domains : DEFAULT_EMAIL_DOMAINS;
  for (let attempt = 0; attempt < 50; attempt++) {
    const domain = pick(list);
    let email;
    if (style === 'polish' && Math.random() < 0.6) {
      const first = pick(PL_NAMES).toLowerCase();
      const last = pick(SURNAMES).toLowerCase();
      const suffix = Math.random() < 0.3 ? String(rnd(1, 99)) : '';
      email = `${first}.${last}${suffix}@${domain}`;
    } else {
      const local = nickname.toLowerCase().replace(/^_+|_+$/g, '');
      email = Math.random() < 0.25 ? `${local}${rnd(1, 99)}@${domain}` : `${local}@${domain}`;
    }
    const key = email.toLowerCase();
    if (!usedEmails.has(key)) {
      usedEmails.add(key);
      return email;
    }
  }
  // ostateczność — unikalny sufiks
  const final = `${nickname.toLowerCase().replace(/^_+|_+$/g, '')}${rnd(1000, 99999)}@${pick(domains)}`;
  usedEmails.add(final.toLowerCase());
  return final;
}
