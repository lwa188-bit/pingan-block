(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const I18N = Game.I18N;

  function element(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function createArt(variant) {
    const art = element('div', 'card-art art-' + variant);
    art.setAttribute('aria-hidden', 'true');

    const parts = [
      'art-grid',
      'art-lane art-lane-a',
      'art-lane art-lane-b',
      'art-crosswalk',
      'art-risk',
      'art-route',
      'art-vehicle art-vehicle-main',
      'art-vehicle art-vehicle-secondary',
      'art-vehicle art-vehicle-tertiary',
      'art-person',
      'art-cyclist',
      'art-signal',
      'art-pixel art-pixel-a',
      'art-pixel art-pixel-b',
      'art-pixel art-pixel-c'
    ];

    parts.forEach(function (className) {
      const part = element('span', className);
      if (className.indexOf('art-vehicle') === 0) {
        part.appendChild(element('i'));
        part.appendChild(element('i'));
      }
      art.appendChild(part);
    });

    const label = element('span', 'art-label', variant === 'bus-ghost' ? 'BLIND SPOT' : variant.toUpperCase().replace('-', ' '));
    art.appendChild(label);
    return art;
  }

  function createCard(game, language) {
    const playable = game.status === 'playable';
    const card = element('article', 'catalog-card ' + (playable ? 'is-playable' : 'is-coming-soon'));
    card.dataset.gameId = game.id;
    card.dataset.status = game.status;

    card.appendChild(createArt(game.art));

    const body = element('div', 'card-body');
    const meta = element('div', 'card-meta');
    meta.appendChild(element('span', 'card-episode', 'EP. ' + game.episode));
    meta.appendChild(element('span', 'card-status', I18N.t(playable ? 'home.available' : 'home.comingSoon')));
    body.appendChild(meta);

    body.appendChild(element('h3', 'card-title', game.title[language] || game.title.zh));
    body.appendChild(element('p', 'card-description', game.description[language] || game.description.zh));

    if (playable && game.href) {
      const link = element('a', 'card-play');
      link.href = I18N.withLanguage(game.href);
      link.setAttribute('aria-label', I18N.t('home.playAria', { title: game.title[language] || game.title.zh }));
      link.appendChild(element('span', '', I18N.t('home.play')));
      const arrow = element('span', 'card-arrow', '→');
      arrow.setAttribute('aria-hidden', 'true');
      link.appendChild(arrow);
      body.appendChild(link);
    } else {
      const upcoming = element('div', 'card-upcoming');
      upcoming.appendChild(element('span', 'upcoming-line'));
      upcoming.appendChild(element('span', '', I18N.t('home.comingSoon')));
      body.appendChild(upcoming);
    }

    card.appendChild(body);
    return card;
  }

  function render() {
    const grid = root.document.getElementById('catalog-grid');
    if (!grid || !I18N || !Array.isArray(Game.CATALOG)) return;

    const language = I18N.getLanguage();
    const fragment = root.document.createDocumentFragment();
    Game.CATALOG.filter(function (game) { return game.status !== 'hidden'; }).forEach(function (game) {
      fragment.appendChild(createCard(game, language));
    });
    grid.replaceChildren(fragment);
  }

  function preserveSeedLink() {
    if (!root.location || !root.URLSearchParams) return false;
    if (!new root.URLSearchParams(root.location.search).has('seed')) return false;
    if (/(?:^|\/)bus-ghost\.html$/.test(root.location.pathname)) return false;

    const destination = I18N.withLanguage('bus-ghost.html' + root.location.search + root.location.hash);
    root.location.replace(destination);
    return true;
  }

  I18N.init(root.document);
  if (!preserveSeedLink()) {
    render();
    I18N.onChange(render);
  }
})(typeof window !== 'undefined' ? window : globalThis);
