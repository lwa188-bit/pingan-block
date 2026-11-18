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

  function createRow(game, language) {
    const playable = game.status === 'playable' && Boolean(game.href);
    const title = game.title[language] || game.title.zh;
    const row = element('li', 'compact-game-row');
    row.dataset.gameId = game.id;
    row.dataset.status = game.status;

    const content = element(playable ? 'a' : 'div', playable ? 'compact-game-link' : 'compact-game-upcoming');
    if (playable) {
      content.href = I18N.withLanguage(game.href);
      content.setAttribute('aria-label', I18N.t('list.playAria', { title: title }));
    }
    content.appendChild(element('span', 'compact-game-episode', 'EP. ' + game.episode));
    content.appendChild(element('strong', 'compact-game-title', title));
    content.appendChild(element('span', playable ? 'compact-game-action' : 'compact-game-status',
      I18N.t(playable ? 'list.play' : 'list.soon')));
    row.appendChild(content);
    return row;
  }

  function render() {
    const list = root.document.getElementById('game-list');
    if (!list || !Array.isArray(Game.CATALOG)) return;
    const language = I18N.getLanguage();
    const fragment = root.document.createDocumentFragment();
    Game.CATALOG.filter(function (game) { return game.status !== 'hidden'; }).forEach(function (game) {
      fragment.appendChild(createRow(game, language));
    });
    list.replaceChildren(fragment);
  }

  I18N.init(root.document);
  render();
  I18N.onChange(render);
})(typeof window !== 'undefined' ? window : globalThis);
